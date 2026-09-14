"""rapp_registry.py — the §13 registry as executable checks. Stdlib only.

RAPP/1 grows by registration, never by fork (Constitution Art. 4). Every estate —
the reference estate, a vendor's factory, your laptop — publishes its own signed
`rapp/1-registry` document, and *that* document is what binds a `kind` to a family,
admits an egg variant or error code, discovers a signer's key, and retires a key by
tombstone. Extending RAPP therefore means writing registry entries, not patching
this repository. This module makes those entries checkable with the reference.

What is fully specified by §13 and enforced here:
  - every entry type and its exact member set (§13.3);
  - kind grammar and family binding; family ↔ stream_id-form compatibility (§6.1.1, §7.2);
  - owner succession by re-anchor records, owner-in-effect at a time (§13.2);
  - key discovery, superseded-key and tombstone refusal at a time (§10);
  - one non-deprecated genesis per stream (§7.6); one grail-kernel per grail_id (§11.1);
  - the document envelope members §13.1 names: `schema`, `registry_seq`, `sig`, and
    owner-signature verification over canonical(document \\ {sig}).

What §13 does NOT yet specify, and this module therefore refuses to guess:
  - the member of the document that holds the entries. `load_document` requires the
    caller to name it explicitly; nothing here defaults it. Until a revision closes
    that gap (see rapp-backlog.md), a registry document is interoperable only by
    out-of-band agreement on that one name. Entries themselves are fully portable.

Nothing here can make an unsigned registry authoritative. `load_document` reports
"verified" only after a §10 signature by the estate owner verifies AND that owner is the
rappid the caller obtained out of band (the trust anchor); an unsigned document is at most
a "draft", and a registry that names any other owner is refused outright.
"""
import base64
import re

import rapp as R

FAMILIES = ("memory", "swarm", "body")
STREAM_FORMS = {"memory": "memory-stream", "swarm": "swarm-stream", "body": "body-stream"}
REANCHOR_CASES = ("upgrade", "rotation", "compromise", "tag-migrate")

_LCLABEL = r"[a-z0-9]+(?:-[a-z0-9]+)*"
_KIND = re.compile(rf"({_LCLABEL})\.({_LCLABEL})")
_LABEL = re.compile(_LCLABEL)
_HEX64 = re.compile(r"[0-9a-f]{64}")
_HEX40 = re.compile(r"[0-9a-f]{40}")
_HTTPS = re.compile(r"https://[^\s]+")

# §13.3 — exact members per entry type: (required, optional)
ENTRY_MEMBERS = {
    "protocol": ({"type", "name", "spec_repo", "spec_path", "spec_hash", "deprecated"}, set()),
    "kind": ({"type", "kind", "family", "deprecated"}, set()),
    "egg-variant": ({"type", "variant", "deprecated"}, set()),
    "error-code": ({"type", "code"}, set()),
    "genesis": ({"type", "stream_id", "frame_hash", "deprecated"}, {"old_stream_id", "new_stream_id"}),
    "spki": ({"type", "rappid", "spki_der_b64", "deprecated"}, set()),
    "tombstone": ({"type", "rappid", "revoked_utc", "sig"}, set()),
    "re-anchor": ({"type", "old_rappid", "new_rappid", "case", "utc", "sig"}, {"old_key_sig"}),
    "grail-kernel": ({"type", "release_scope", "grail_id", "repository", "immutable_ref",
                      "object_format", "commit", "path", "mode", "blob", "sha256", "size_bytes",
                      "activated_utc", "predecessor", "declared_by", "sig"}, set()),
    "estate_owner": ({"type", "rappid"}, set()),
    "master-plan": ({"type", "repo", "path"}, set()),
}


class RegistryError(ValueError):
    """A registry that must be refused, whole (§7.5-style: never partial, never repaired)."""


def kind_valid(kind):
    """§6.1.1 `kind = lclabel "." lclabel`, each label 1–64."""
    m = _KIND.fullmatch(kind) if isinstance(kind, str) else None
    return bool(m and 1 <= len(m.group(1)) <= 64 and 1 <= len(m.group(2)) <= 64)


def stream_form(stream_id):
    """§6.1.1: which stream form a stream_id is, or None if it is none of them."""
    if not isinstance(stream_id, str):
        return None
    if stream_id.startswith("net:"):
        label = stream_id[4:]
        return "swarm-stream" if _LABEL.fullmatch(label) else None
    if R.rappid_valid(stream_id):
        return "body-stream"
    head, sep, instance = stream_id.rpartition(":")
    if sep and R.rappid_valid(head) and _LABEL.fullmatch(instance) and 1 <= len(instance) <= 64:
        return "memory-stream"
    return None


def _bool(entry, member, where):
    if not isinstance(entry.get(member), bool):
        raise RegistryError(f"{where}: `{member}` must be a JSON boolean")


def _str(entry, member, where):
    if not isinstance(entry.get(member), str) or not entry[member]:
        raise RegistryError(f"{where}: `{member}` must be a non-empty string")
    return entry[member]


def _rappid(entry, member, where):
    if not R.rappid_valid(entry.get(member)):
        raise RegistryError(f"{where}: `{member}` is not a §6.1 rappid")
    return entry[member]


def _utc(entry, member, where):
    if not R.utc_valid(entry.get(member)):
        raise RegistryError(f"{where}: `{member}` is not the fixed §7.4 UTC form")
    return entry[member]


def _hex64(entry, member, where):
    v = entry.get(member)
    if not (isinstance(v, str) and _HEX64.fullmatch(v)):
        raise RegistryError(f"{where}: `{member}` must be 64 lowercase hex")
    return v


def validate_entry(entry, where="entry"):
    """Refuse an entry that is not exactly a §13.3 entry of its type. Returns the type."""
    if not isinstance(entry, dict):
        raise RegistryError(f"{where}: not an object")
    t = entry.get("type")
    if t not in ENTRY_MEMBERS:
        raise RegistryError(f"{where}: unknown entry type {t!r}")
    required, optional = ENTRY_MEMBERS[t]
    keys = set(entry.keys())
    if not required <= keys or not keys <= (required | optional):
        raise RegistryError(
            f"{where} ({t}): member set {sorted(keys)} != exactly {sorted(required)}"
            + (f" plus optional {sorted(optional)}" if optional else "")
        )
    if t == "protocol":
        _str(entry, "name", where); _str(entry, "spec_path", where); _bool(entry, "deprecated", where)
        if not _HTTPS.fullmatch(_str(entry, "spec_repo", where)):
            raise RegistryError(f"{where}: `spec_repo` must be an absolute HTTPS URI")
        _hex64(entry, "spec_hash", where)
        name = entry["name"]
        if name == "rapp/1" and not entry["deprecated"]:
            if entry["spec_repo"] != "https://github.com/kody-w/rapp-1" or entry["spec_path"] != "SPEC.md":
                raise RegistryError(f"{where}: a current `rapp/1` pin must point at kody-w/rapp-1 SPEC.md")
        elif name != "rapp/1" and (name.startswith("rapp/") or name.startswith("rapp-1")):
            raise RegistryError(f"{where}: another protocol may not claim the rapp/1 name or namespace")
    elif t == "kind":
        if not kind_valid(entry.get("kind")):
            raise RegistryError(f"{where}: `kind` fails the §6.1.1 grammar")
        if entry.get("family") not in FAMILIES:
            raise RegistryError(f"{where}: `family` must be one of {FAMILIES}")
        _bool(entry, "deprecated", where)
    elif t == "egg-variant":
        v = _str(entry, "variant", where)
        if not _LABEL.fullmatch(v):
            raise RegistryError(f"{where}: `variant` must be an lclabel")
        _bool(entry, "deprecated", where)
    elif t == "error-code":
        _str(entry, "code", where)
    elif t == "genesis":
        if stream_form(entry.get("stream_id")) is None:
            raise RegistryError(f"{where}: `stream_id` is not a §6.1.1 stream form")
        _hex64(entry, "frame_hash", where); _bool(entry, "deprecated", where)
        for m in ("old_stream_id", "new_stream_id"):
            if m in entry and stream_form(entry[m]) is None:
                raise RegistryError(f"{where}: `{m}` is not a §6.1.1 stream form")
    elif t == "spki":
        _rappid(entry, "rappid", where); _bool(entry, "deprecated", where)
        try:
            der = base64.b64decode(_str(entry, "spki_der_b64", where), validate=True)
        except Exception:
            raise RegistryError(f"{where}: `spki_der_b64` is not base64")
        if R.Hb("rapp/1:rappid", der) != R.rappid_parts(entry["rappid"])["hash"]:
            raise RegistryError(f"{where}: SPKI does not hash to the rappid tail (§10 key discovery)")
    elif t == "tombstone":
        _rappid(entry, "rappid", where); _utc(entry, "revoked_utc", where); _str(entry, "sig", where)
    elif t == "re-anchor":
        _rappid(entry, "old_rappid", where); _rappid(entry, "new_rappid", where)
        if entry.get("case") not in REANCHOR_CASES:
            raise RegistryError(f"{where}: `case` must be one of {REANCHOR_CASES}")
        _utc(entry, "utc", where); _str(entry, "sig", where)
        if entry["case"] == "rotation" and "old_key_sig" not in entry:
            raise RegistryError(f"{where}: case rotation REQUIRES `old_key_sig`")
        if "old_key_sig" in entry:
            _str(entry, "old_key_sig", where)
    elif t == "grail-kernel":
        for m in ("release_scope", "repository"):
            if not _HTTPS.fullmatch(_str(entry, m, where)):
                raise RegistryError(f"{where}: `{m}` must be an absolute HTTPS URI")
        if not _str(entry, "immutable_ref", where).startswith("refs/tags/"):
            raise RegistryError(f"{where}: `immutable_ref` must be a full refs/tags/... name")
        fmt = entry.get("object_format")
        if fmt not in ("sha1", "sha256"):
            raise RegistryError(f"{where}: `object_format` must be sha1 or sha256")
        hexre = _HEX40 if fmt == "sha1" else _HEX64
        for m in ("commit", "blob"):
            if not (isinstance(entry.get(m), str) and hexre.fullmatch(entry[m])):
                raise RegistryError(f"{where}: `{m}` must be lowercase hex of the {fmt} length")
        gid = _str(entry, "grail_id", where)
        if not (gid.startswith("grail:") and _HEX64.fullmatch(gid[6:])):
            raise RegistryError(f"{where}: `grail_id` must be grail:<64hex>")
        if entry.get("mode") not in ("100644", "100755"):
            raise RegistryError(f"{where}: `mode` must be 100644 or 100755")
        path = _str(entry, "path", where)
        parts = path.split("/")
        if path.startswith("/") or any(p in ("", ".", "..") for p in parts):
            raise RegistryError(f"{where}: `path` must be a relative POSIX path with no empty/./.. component")
        _hex64(entry, "sha256", where)
        n = entry.get("size_bytes")
        if not (isinstance(n, int) and not isinstance(n, bool) and 0 < n <= 2**53 - 1):
            raise RegistryError(f"{where}: `size_bytes` must be a positive uint53")
        _utc(entry, "activated_utc", where)
        if entry.get("predecessor") is not None:
            p = entry["predecessor"]
            if not (isinstance(p, str) and p.startswith("grail:") and _HEX64.fullmatch(p[6:])):
                raise RegistryError(f"{where}: `predecessor` must be null or a grail_id")
        _rappid(entry, "declared_by", where); _str(entry, "sig", where)
    elif t == "estate_owner":
        _rappid(entry, "rappid", where)
    elif t == "master-plan":
        _str(entry, "repo", where); _str(entry, "path", where)
    return t


class Registry:
    """An estate's registry, loaded from its §13.3 entries and answering §7/§10 questions."""

    def __init__(self, entries):
        if not isinstance(entries, list):
            raise RegistryError("entries must be a JSON array")
        self.entries = entries
        self.kinds = {}          # kind -> entry
        self.egg_variants = {}   # variant -> entry
        self.error_codes = set()
        self.spki = {}           # rappid -> entry
        self.tombstones = {}     # rappid -> revoked_utc (earliest)
        self.reanchors = []      # entries, in order
        self.genesis = {}        # stream_id -> list of entries
        self.grail = {}          # grail_id -> entry
        self.protocols = {}      # name -> entry
        self.master_plan = None
        owners = []
        for i, e in enumerate(entries):
            where = f"entries[{i}]"
            t = validate_entry(e, where)
            if t == "kind":
                if e["kind"] in self.kinds:
                    raise RegistryError(f"{where}: kind {e['kind']!r} registered twice (append-only, closed)")
                self.kinds[e["kind"]] = e
            elif t == "egg-variant":
                if e["variant"] in self.egg_variants:
                    raise RegistryError(f"{where}: variant {e['variant']!r} registered twice")
                self.egg_variants[e["variant"]] = e
            elif t == "error-code":
                self.error_codes.add(e["code"])
            elif t == "spki":
                if e["rappid"] in self.spki:
                    raise RegistryError(f"{where}: spki for {e['rappid']} registered twice")
                self.spki[e["rappid"]] = e
            elif t == "tombstone":
                prior = self.tombstones.get(e["rappid"])
                self.tombstones[e["rappid"]] = min(prior, e["revoked_utc"]) if prior else e["revoked_utc"]
            elif t == "re-anchor":
                if R.rappid_parts(e["old_rappid"])["hash"] == R.rappid_parts(e["new_rappid"])["hash"]:
                    raise RegistryError(f"{where}: re-anchor requires a fresh identity tail")
                if any(r["new_rappid"] == e["new_rappid"] for r in self.reanchors):
                    raise RegistryError(f"{where}: more than one predecessor for a re-anchored identity")
                self.reanchors.append(e)
            elif t == "genesis":
                self.genesis.setdefault(e["stream_id"], []).append(e)
            elif t == "grail-kernel":
                if e["grail_id"] in self.grail:
                    raise RegistryError(f"{where}: second grail-kernel entry for {e['grail_id']} (kernel-drift)")
                if e["release_scope"] in {g["release_scope"] for g in self.grail.values()}:
                    raise RegistryError(f"{where}: release_scope {e['release_scope']!r} rebound")
                self.grail[e["grail_id"]] = e
            elif t == "protocol":
                self.protocols.setdefault(e["name"], e)
            elif t == "estate_owner":
                owners.append(e["rappid"])
            elif t == "master-plan":
                self.master_plan = e
        if len(owners) != 1:
            raise RegistryError(f"exactly one estate_owner entry is required, found {len(owners)}")
        self.estate_owner = owners[0]
        for sid, gs in self.genesis.items():
            if sum(1 for g in gs if not g["deprecated"]) > 1:
                raise RegistryError(f"stream {sid}: more than one non-deprecated genesis (§7.6)")
        for g in self.grail.values():
            if g["predecessor"] is not None and g["predecessor"] not in self.grail:
                raise RegistryError(f"grail-kernel {g['grail_id']}: predecessor is not an accepted entry")
        # predecessor cycles
        for gid in self.grail:
            seen, cur = set(), gid
            while cur is not None:
                if cur in seen:
                    raise RegistryError(f"grail-kernel predecessor cycle through {gid}")
                seen.add(cur)
                cur = self.grail[cur]["predecessor"]
        self._succession = {r["new_rappid"]: r for r in self.reanchors}
        succession_by_tail = {}
        for record in self.reanchors:
            tail = R.rappid_parts(record["new_rappid"])["hash"]
            if tail in succession_by_tail:
                raise RegistryError("re-anchor must mint a fresh tail, not another name for one")
            succession_by_tail[tail] = record
        for successor in succession_by_tail:
            seen, current = set(), successor
            while True:
                if current in seen:
                    raise RegistryError("re-anchor succession reuses an ancestral identity tail")
                seen.add(current)
                record = succession_by_tail.get(current)
                if record is None:
                    break
                current = R.rappid_parts(record["old_rappid"])["hash"]

    # ---- §7.2 / §6.1.1 kind binding ----
    def family(self, kind):
        e = self.kinds.get(kind)
        return None if e is None or e["deprecated"] else e["family"]

    def check_frame_binding(self, frame):
        """Registry-bound part of §7.5 step 1: kind registered here, family compatible with
        the stream form. Returns (ok, reason). Run alongside rapp.verify_frame."""
        kind = frame.get("kind")
        fam = self.family(kind)
        if fam is None:
            return False, f"kind {kind!r} is not a live registered kind of this estate"
        form = stream_form(frame.get("stream_id"))
        if form is None:
            return False, "stream_id is not a §6.1.1 stream form"
        if STREAM_FORMS[fam] != form:
            return False, f"kind family {fam!r} is incompatible with {form}"
        return True, "ok"

    # ---- §13.2 owner succession ----
    def owner_at(self, utc):
        """The estate-owner rappid in effect at `utc` (walks re-anchor records backwards)."""
        owner, seen = self.estate_owner, set()
        while True:
            if owner in seen:
                raise RegistryError("re-anchor succession cycle")
            seen.add(owner)
            rec = self._succession.get(owner)
            if rec is None or utc >= rec["utc"]:
                return owner
            owner = rec["old_rappid"]

    # ---- §10 signer acceptability at a time ----
    def signer_acceptable(self, kid, utc):
        """Is a `sig` by `kid` on an artifact at `utc` acceptable: key discoverable, not
        superseded by a re-anchor at or before utc, not tombstoned at or before utc."""
        return self._signer_acceptable(kid, utc)

    def _signer_acceptable(self, kid, utc, ignored_reanchor=None, match_key_aliases=False):
        e = self.spki.get(kid)
        if e is None:
            return False, "no spki entry for kid (registry absence is refusal)"
        target = R.rappid_parts(kid)["hash"] if match_key_aliases else kid
        def matches(other):
            return (R.rappid_parts(other)["hash"] if match_key_aliases else other) == target
        for r in self.reanchors:
            if r is ignored_reanchor:
                continue
            if matches(r["old_rappid"]) and utc >= r["utc"]:
                return False, f"kid superseded by re-anchor ({r['case']}) at {r['utc']}"
        if e["deprecated"] and not any(matches(r["old_rappid"]) for r in self.reanchors):
            return False, "spki entry deprecated"
        revocations = [revoked for identity, revoked in self.tombstones.items() if matches(identity)]
        rv = min(revocations) if revocations else None
        if rv is not None and utc >= rv:
            return False, f"kid tombstoned at {rv}"
        return True, "ok"

    def spki_der(self, kid):
        e = self.spki.get(kid)
        return None if e is None else base64.b64decode(e["spki_der_b64"], validate=True)

    def signature_verifier(self):
        """A callable shaped for rapp.verify_frame(signature_verifier=...) that resolves
        keys from this registry and applies the time-scoped §10 rules."""
        def verify(unsigned, sig, expected_signer=None):
            try:
                header = R.parse_detached_jws(sig)[0]
            except ValueError as why:
                return False, str(why)
            kid = header["kid"]
            if expected_signer is not None and kid != expected_signer:
                return False, "kid is not the required signer"
            utc = unsigned.get("utc") or unsigned.get("created_utc") or unsigned.get("activated_utc")
            if utc is None:
                return False, "artifact carries no utc to scope the signer's authority"
            ok, why = self.signer_acceptable(kid, utc)
            if not ok:
                return False, why
            return R.verify_detached_jws(unsigned, sig, self.spki_der(kid), expected_kid=kid)
        return verify

    def registered_genesis(self, stream_id):
        for g in self.genesis.get(stream_id, []):
            if not g["deprecated"]:
                return g
        return None

    def check_lifecycle_signatures(self, *, tombstone_issued_at=None):
        """Check the signatures on lifecycle entries, not only their outer registry.

        This checks owner tenure and old-key continuity. A snapshot cannot prove
        which entries arrived in the same append; callers must retain append
        provenance for the additional §6.3 compromise requirement. Tombstones
        have a cutoff, not an issuance UTC: a trusted context resolver must
        supply the latter, keyed by the exact signed entry's particle hash.
        """
        owner, seen, owner_transitions = self.estate_owner, set(), set()
        while owner in self._succession:
            if owner in seen:
                raise RegistryError("re-anchor succession cycle")
            seen.add(owner)
            record = self._succession[owner]
            prior = self._succession.get(record["old_rappid"])
            if prior is not None and prior["utc"] >= record["utc"]:
                raise RegistryError("owner succession requires a nonempty, forward tenure")
            owner_transitions.add(record["new_rappid"])
            owner = record["old_rappid"]

        def verify(value, sig, expected_kid):
            der = self.spki_der(expected_kid)
            if der is None:
                return False, "lifecycle signer has no registered spki"
            return R.verify_detached_jws(value, sig, der, expected_kid=expected_kid)

        for entry in self.entries:
            kind = entry["type"]
            if kind not in ("tombstone", "re-anchor"):
                continue
            if kind == "tombstone":
                if not callable(tombstone_issued_at):
                    return False, "tombstone issuance time requires trusted append/issuance context"
                try:
                    utc = tombstone_issued_at(R.H("rapp/1:particle", entry))
                except (KeyError, ValueError) as why:
                    return False, f"tombstone issuance context refused: {why}"
                if not R.utc_valid(utc):
                    return False, "tombstone issuance context did not supply a valid UTC"
            else:
                utc = entry["utc"]
            if kind == "re-anchor" and entry["new_rappid"] in owner_transitions:
                # The outgoing owner signs its own transition at the tenure boundary.
                signer = entry["old_rappid"]
            else:
                signer = self.owner_at(utc)
            unsigned = {k: v for k, v in entry.items() if k != "sig"}
            ok, why = verify(unsigned, entry["sig"], signer)
            if not ok:
                return False, f"{kind} owner signature refused: {why}"
            if kind == "re-anchor":
                if "old_key_sig" in entry:
                    if entry["case"] == "rotation":
                        ok, why = self._signer_acceptable(
                            entry["old_rappid"], utc, ignored_reanchor=entry,
                            match_key_aliases=True,
                        )
                        if not ok:
                            return False, f"rotation old-key authority refused: {why}"
                    continuity = {k: v for k, v in entry.items()
                                  if k not in ("sig", "old_key_sig")}
                    ok, why = verify(continuity, entry["old_key_sig"], entry["old_rappid"])
                    if not ok:
                        return False, f"re-anchor old-key signature refused: {why}"
                if entry["case"] == "compromise" and entry["old_rappid"] not in self.tombstones:
                    return False, "compromise re-anchor requires a registered tombstone"
        return True, "ok"


def load_document(doc, *, entries_member, trust_anchor, allow_unsigned=False,
                  persisted_seq=None, tombstone_issued_at=None):
    """Load a `rapp/1-registry` document. Returns (status, registry, reason) where status is
    "verified" (owner signature verified AGAINST THE TRUST ANCHOR), "draft" (unsigned and
    allow_unsigned), or "refused".

    `trust_anchor` is REQUIRED: the estate-owner rappid you obtained out of band (§13.1 — the
    one bootstrap axiom). A document whose `estate_owner` entry names any other rappid is
    refused before its signature is even checked; without this, a registry signed by a
    self-minted key would verify against itself. `entries_member` is REQUIRED because §13
    does not yet name the member that holds the entries. `persisted_seq` implements §13.1
    no-rollback: a lower `registry_seq` is refused. Signed documents also verify
    each lifecycle entry's owner signature and any old-key continuity signature.
    Freshness, append provenance, and historical migration proofs remain caller
    responsibilities; a verified snapshot alone cannot establish them.
    `tombstone_issued_at(entry_hash)` must resolve authenticated issuance/append
    context to a fixed UTC string. It is trusted caller configuration, never a
    field read from the untrusted document. No resolver means tombstones are
    refused: revoked_utc cannot be silently reinterpreted as issuance time."""
    if not R.rappid_valid(trust_anchor):
        return "refused", None, "trust_anchor must be the out-of-band estate-owner rappid"
    if not isinstance(doc, dict) or doc.get("schema") != "rapp/1-registry":
        return "refused", None, 'document schema must be "rapp/1-registry"'
    seq = doc.get("registry_seq")
    if not (isinstance(seq, int) and not isinstance(seq, bool) and 0 <= seq <= 2**53 - 1):
        return "refused", None, "registry_seq must be uint53"
    if persisted_seq is not None and seq < persisted_seq:
        return "refused", None, f"registry_seq {seq} < persisted {persisted_seq} (rollback)"
    if entries_member not in doc:
        return "refused", None, f"document has no {entries_member!r} member"
    try:
        R.canonical(doc)  # §4 input-domain profile: refuse, never repair
        reg = Registry(doc[entries_member])
    except (RegistryError, ValueError) as why:
        return "refused", None, str(why)
    if reg.estate_owner != trust_anchor:
        return "refused", None, "estate_owner does not match the out-of-band trust anchor (§13.1)"
    sig = doc.get("sig")
    if sig is None:
        if allow_unsigned:
            return "draft", reg, "unsigned: a draft, never authority (§13.1)"
        return "refused", None, "unsigned registry (§13.1 MUST refuse)"
    unsigned = {k: v for k, v in doc.items() if k != "sig"}
    der = reg.spki_der(reg.estate_owner)
    if der is None:
        return "refused", None, "no spki entry for the estate_owner; the tail check cannot run"
    ok, why = R.verify_detached_jws(unsigned, sig, der, expected_kid=reg.estate_owner)
    if not ok:
        return "refused", None, why
    try:
        ok, why = reg.check_lifecycle_signatures(tombstone_issued_at=tombstone_issued_at)
    except RegistryError as why:
        return "refused", None, str(why)
    if not ok:
        return "refused", None, why
    return "verified", reg, "ok"
