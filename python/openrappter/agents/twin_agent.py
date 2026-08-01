"""
TwinAgent — your twin, on the grail brainstem.

The same twin must be able to live on either set of bones. A twin that only
works on one platform is not a twin, it is a lock-in: the whole promise of
Article LVI is that the GOD half is *yours* and survives the tooling around it.

So this reads the identical vault openrappter's `src/twin/` writes —
`~/.rapp/twin/profile.json`, one file, one schema — and renders the identical
persona from it. Move the folder to another machine, or switch platforms, and
your twin is unchanged.

    grail brainstem  (Python)      ─┐
                                    ├─► ~/.rapp/twin/profile.json
    openrappter      (TypeScript)  ─┘

Portability is not claimed here, it is tested: `tests/twin-parity.json` holds
the cases both implementations must render identically, and both suites read it.

The vault lives OUTSIDE this agent's storage shim on purpose. The shim is
brainstem-scoped state; the twin is the operator's sovereign half and must not
be entangled with an install that gets wiped and re-created. This is the one
sanctioned direct read in the agent set, and it is read-only.

Actions: soul, show, context, shape, where
"""

import datetime
import hashlib
import json
import os

try:  # grail brainstem
    from agents.basic_agent import BasicAgent
except ImportError:  # openrappter's python package
    from openrappter.agents.basic_agent import BasicAgent


__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@openrappter/twin",
    "version": "1.0.0",
    "display_name": "Twin",
    "description": "The operator's digital twin — the GOD half, read from the device vault, never published.",
    "author": "Kody Wildfeuer",
    "ring": "ga",
    "capabilities": ["filesystem-read"],
    "tags": ["twin", "identity", "local-first", "article-lvi"],
    "category": "identity",
    "quality_tier": "official",
    "requires_env": [],
}

SHAPE_SPEC = "rapp-twin-shape/1.0"


def _vault_dir():
    return os.path.expanduser(os.environ.get("RAPP_TWIN_HOME") or os.path.join("~", ".rapp", "twin"))


def _profile_path():
    return os.path.join(_vault_dir(), "profile.json")


def _inside_git_repo(path):
    """A vault inside a working tree is one `git add -A` from being public."""
    current = os.path.abspath(path)
    while True:
        if os.path.exists(os.path.join(current, ".git")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def _bullets(items, indent="  "):
    return "\n".join("%s- %s" % (indent, item) for item in items)


def _section(title, body):
    return "%s\n%s" % (title, body) if body.strip() else ""


def disclosure_rules(audience):
    """
    The non-negotiable part, kept out of the editable profile.

    A twin whose limits live in user-editable text has no limits.
    """
    shared = [
        "You are an AI acting as this person's twin. If anyone asks, say so plainly. Never claim to be human.",
        "Never invent a fact about the owner. If you do not know, say so and offer to ask them.",
        'You may act within "You may" below. Anything under "Ask first" needs their explicit yes, and a pending question is not a yes.',
    ]
    if audience == "owner":
        return "\n".join(shared + ["You are talking to the owner, so speak freely about their own context."])
    if audience == "trusted":
        return "\n".join(
            shared
            + [
                "You are talking to someone the owner trusts, but not the owner.",
                "Do not disclose contact details, account handles, addresses, phone numbers, or anything about third parties.",
                "Share project context only when it is plainly relevant to what was asked.",
            ]
        )
    return "\n".join(
        shared
        + [
            "You are talking to a stranger. Assume everything you say may become public.",
            "Do not disclose ANY personal detail about the owner: no contact details, no account handles, "
            "no addresses, no phone numbers, no schedule, no relationships, no client or customer names.",
            "If asked for something personal, decline plainly and offer to pass the message on. "
            "Do not hint at what you are withholding.",
        ]
    )


def render_soul(profile, audience="owner"):
    """Must render byte-identically to openrappter's renderSoul()."""
    identity = profile.get("identity") or {}
    voice = profile.get("voice") or {}
    context = profile.get("context") or {}
    boundaries = profile.get("boundaries") or {}

    name = identity.get("name") or "Owner"
    short = identity.get("shortName") or name
    parts = [
        "You are %s's digital twin — a rappter that thinks and writes the way %s does." % (name, short)
    ]

    who = []
    if identity.get("pronouns"):
        who.append("Pronouns: %s" % identity["pronouns"])
    if identity.get("timezone"):
        who.append("Timezone: %s" % identity["timezone"])
    for role in profile.get("roles") or []:
        if audience == "public":
            # org and focus are routinely a customer name.
            who.append(role.get("title", ""))
        else:
            line = role.get("title", "")
            if role.get("org"):
                line += " at %s" % role["org"]
            if role.get("focus"):
                line += " — %s" % role["focus"]
            who.append(line)
    if who:
        parts.append(_section("# Who they are", _bullets(who)))

    style = []
    if voice.get("tone"):
        style.append("Sound: %s." % ", ".join(voice["tone"]))
    if voice.get("avoid"):
        style.append("Never: %s." % ", ".join(voice["avoid"]))
    if voice.get("signatures"):
        style.append("Recognisably them: %s." % ", ".join('"%s"' % s for s in voice["signatures"]))
    if style:
        parts.append(_section("# How they sound", _bullets(style)))

    if audience != "public":
        working = []
        for project in context.get("projects") or []:
            line = "%s — %s" % (project.get("name", ""), project.get("what", ""))
            if project.get("where"):
                line += " (%s)" % project["where"]
            working.append(line)
        if context.get("tools"):
            working.append("Tools: %s." % ", ".join(context["tools"]))
        if working:
            parts.append(_section("# What they are working on", _bullets(working)))

        if context.get("facts"):
            parts.append(_section("# Standing facts", _bullets(context["facts"])))

        if audience == "owner" and context.get("people"):
            people = []
            for person in context["people"]:
                line = "%s — %s" % (person.get("name", ""), person.get("relationship", ""))
                if person.get("notes"):
                    line += ". %s" % person["notes"]
                people.append(line)
            parts.append(_section("# People", _bullets(people)))

    mandate = []
    if boundaries.get("mayDo"):
        mandate.append("You may:\n%s" % _bullets(boundaries["mayDo"], "    "))
    if boundaries.get("mustAsk"):
        mandate.append("Ask first:\n%s" % _bullets(boundaries["mustAsk"], "    "))
    if boundaries.get("neverDo"):
        mandate.append("Never:\n%s" % _bullets(boundaries["neverDo"], "    "))
    if mandate:
        parts.append(_section("# Your mandate", _bullets(mandate)))

    parts.append(_section("# Always", disclosure_rules(audience)))

    return "\n\n".join(p for p in parts if p)


def fingerprint(profile):
    """Stable, comparable, and empty — the whole permitted public surface of identity."""
    material = "|".join(
        [
            str(profile.get("id", "")),
            str((profile.get("identity") or {}).get("name", "")),
            str(len(profile.get("roles") or [])),
            str(len((profile.get("context") or {}).get("projects") or [])),
            str(len((profile.get("context") or {}).get("people") or [])),
            str(len((profile.get("voice") or {}).get("tone") or [])),
        ]
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def to_shape(profile):
    """The only sanctioned export: counts and field names, never a value."""
    identity = profile.get("identity") or {}
    voice = profile.get("voice") or {}
    context = profile.get("context") or {}
    boundaries = profile.get("boundaries") or {}
    return {
        "schema": SHAPE_SPEC,
        "version": profile.get("version", 1),
        "present": {
            "identity": sorted(k for k, v in identity.items() if v not in (None, "")),
            "roles": len(profile.get("roles") or []),
            "voice": {
                "tone": len(voice.get("tone") or []),
                "avoid": len(voice.get("avoid") or []),
                "signatures": len(voice.get("signatures") or []),
            },
            "context": {
                "projects": len(context.get("projects") or []),
                "people": len(context.get("people") or []),
                "tools": len(context.get("tools") or []),
                "facts": len(context.get("facts") or []),
            },
            "boundaries": {
                "mayDo": len(boundaries.get("mayDo") or []),
                "mustAsk": len(boundaries.get("mustAsk") or []),
                "neverDo": len(boundaries.get("neverDo") or []),
            },
            "accounts": len(profile.get("accounts") or {}),
        },
        "fingerprint": fingerprint(profile),
    }


class TwinAgent(BasicAgent):
    def __init__(self):
        self.name = "Twin"
        self.metadata = {
            "name": self.name,
            "description": (
                "The operator's digital twin. Read who they are, how they sound, what they are working "
                "on, and the mandate you act under. The twin is the GOD half: it lives on this device "
                "and is never published. Use 'shape' when something needs to leave the machine."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["soul", "show", "context", "shape", "where"],
                        "description": "soul = the persona; shape = the only safe thing to share.",
                    },
                    "audience": {
                        "type": "string",
                        "enum": ["owner", "trusted", "public"],
                        "description": "Who is on the other end. Defaults to owner.",
                    },
                },
                "required": ["action"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def _load(self):
        path = _profile_path()
        if not os.path.exists(path):
            return None
        try:
            with open(path, "r") as handle:
                return json.load(handle)
        except (ValueError, OSError):
            return None

    def system_context(self):
        """Inject the twin into every turn — this is what makes it the default."""
        profile = self._load()
        if not profile:
            return None
        return "<twin>\n%s\n</twin>" % render_soul(profile, "owner")

    def perform(self, **kwargs):
        action = kwargs.get("action") or "show"
        audience = kwargs.get("audience") or "owner"

        try:
            profile = self._load()

            if profile is None:
                return json.dumps(
                    {
                        "status": "error",
                        "message": "no twin on this device yet",
                        "vault": _vault_dir(),
                        "fix": "openrappter twin init \"Your Name\", or ./plant in a RAPP Repo",
                    },
                    indent=2,
                )

            if action == "soul":
                return render_soul(profile, audience)

            if action == "context":
                return "<twin>\n%s\n</twin>" % render_soul(profile, audience)

            if action == "shape":
                return json.dumps(to_shape(profile), indent=2)

            if action == "where":
                repo = _inside_git_repo(_vault_dir())
                return json.dumps(
                    {
                        "status": "ok",
                        "vault": _vault_dir(),
                        "inside_git_repo": bool(repo),
                        "warning": ("vault is inside %s — this is unsafe" % repo) if repo else None,
                    },
                    indent=2,
                )

            identity = profile.get("identity") or {}
            context = profile.get("context") or {}
            return json.dumps(
                {
                    "status": "ok",
                    "name": identity.get("name"),
                    "counts": {
                        "roles": len(profile.get("roles") or []),
                        "projects": len(context.get("projects") or []),
                        "people": len(context.get("people") or []),
                        "facts": len(context.get("facts") or []),
                        "accounts": len(profile.get("accounts") or {}),
                    },
                    "fingerprint": fingerprint(profile),
                    "note": "Counts only. Use action='soul' for the persona; accounts are never printed.",
                },
                indent=2,
            )

        except Exception as exc:
            return json.dumps({"status": "error", "action": action, "message": str(exc)}, indent=2)
