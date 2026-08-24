#!/usr/bin/env python3
"""Sequential, checkpointed release-ring activation orchestrator."""
from __future__ import annotations
import argparse, base64, json, os, stat, subprocess, sys, time, urllib.parse
from datetime import datetime, timezone
from pathlib import Path

RINGS = ("nightly", "alpha", "canary", "beta", "stable")
TRAIN = "kody-w/openrappter-release-train"
RELEASE_RUN_FIELDS = "databaseId,status,conclusion,headSha,headBranch,event,createdAt"

def tag_candidate_id(tag: str) -> str:
    return "tag-" + base64.urlsafe_b64encode(tag.encode()).decode().rstrip("=")

def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".new")
    temp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    os.chmod(temp, stat.S_IRUSR | stat.S_IWUSR)
    temp.replace(path)

def _created_at(value):
    if isinstance(value, (int, float)):
        return value
    if not isinstance(value, str):
        raise RuntimeError("release run createdAt is malformed")
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()

def matching_release_runs(rows: list[dict], baseline: dict, fresh_only: bool) -> list[dict]:
    matches = []
    for row in rows:
        if (
            row.get("event") != "push"
            or row.get("headBranch") != baseline["tag"]
            or row.get("headSha") != baseline["source_commit"]
        ):
            continue
        if fresh_only and (
            row.get("databaseId") in baseline["run_ids"]
            or _created_at(row.get("createdAt")) < _created_at(baseline["captured_at"])
        ):
            continue
        matches.append(row)
    return sorted(matches, key=lambda row: row["databaseId"])

class LiveGitHub:
    def __init__(self, timeout: int): self.timeout = timeout
    def call(self, *args: str) -> str:
        result = subprocess.run(["gh", *args], text=True, capture_output=True)
        if result.returncode: raise RuntimeError(result.stderr.strip() or "gh failed")
        return result.stdout.strip()
    def workflow(self, repo: str, workflow: str, fields: dict[str, str]) -> None:
        before_rows=json.loads(self.call("run","list","-R",repo,"--workflow",workflow,"--limit","20","--json","databaseId"))
        before={item["databaseId"] for item in before_rows}
        args=["workflow","run",workflow,"-R",repo]
        for key,value in fields.items(): args += ["-f",f"{key}={value}"]
        self.call(*args)
        deadline=time.time()+self.timeout
        run_id=None
        while time.time()<deadline:
            rows=json.loads(self.call("run","list","-R",repo,"--workflow",workflow,"--limit","20","--json","databaseId,status,conclusion,headSha"))
            fresh=[row for row in rows if row["databaseId"] not in before]
            if fresh: run_id=fresh[0]["databaseId"]; break
            time.sleep(3)
        if run_id is None: raise RuntimeError(f"{workflow} run did not appear")
        while time.time()<deadline:
            row=json.loads(self.call("run","view",str(run_id),"-R",repo,"--json","status,conclusion"))
            if row["status"]=="completed":
                if row["conclusion"]!="success": raise RuntimeError(f"{workflow} failed: {row['conclusion']}")
                return
            time.sleep(5)
        raise RuntimeError(f"{workflow} timed out")
    def release_baseline(self, tag: str, source_commit: str) -> dict:
        captured_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00","Z")
        rows=json.loads(self.call(
            "run","list","-R","kody-w/openrappter","--workflow","release.yml",
            "--branch",tag,"--limit","100","--json",RELEASE_RUN_FIELDS,
        ))
        refs=self.api_json(
            "repos/kody-w/openrappter/git/matching-refs/tags/"
            f"{urllib.parse.quote(tag,safe='')}"
        )
        exact_refs=[row for row in refs if row.get("ref")==f"refs/tags/{tag}"]
        if len(exact_refs)>1: raise RuntimeError("release tag ref is ambiguous")
        tag_commit=None
        if exact_refs:
            tag_commit=self.api_json(
                f"repos/kody-w/openrappter/commits/{urllib.parse.quote(tag,safe='')}"
            )["sha"]
            if tag_commit!=source_commit: raise RuntimeError("existing release tag targets another commit")
        baseline={
            "run_ids":{row["databaseId"] for row in rows},
            "captured_at":captured_at,
            "tag":tag,
            "source_commit":source_commit,
            "tag_existed":tag_commit is not None,
        }
        existing=matching_release_runs(rows,baseline,fresh_only=False)
        if baseline["tag_existed"] and len(existing)>1:
            raise RuntimeError("release.yml exact tag/source run is ambiguous")
        baseline["existing_matches"]=existing if baseline["tag_existed"] else []
        return baseline
    def wait_release(self, baseline: dict) -> int:
        deadline=time.time()+self.timeout
        selected=None
        while time.time()<deadline:
            rows=json.loads(self.call(
                "run","list","-R","kody-w/openrappter","--workflow","release.yml",
                "--branch",baseline["tag"],"--limit","100","--json",RELEASE_RUN_FIELDS,
            ))
            fresh=matching_release_runs(rows,baseline,fresh_only=True)
            candidates=[*baseline["existing_matches"],*fresh]
            if len(candidates)>1: raise RuntimeError("multiple release.yml runs match exact tag/source identity")
            if candidates:
                selected=candidates[0]
                break
            time.sleep(3)
        if selected is None: raise RuntimeError("release.yml exact tag/source run did not appear")
        run_id=selected["databaseId"]
        while time.time()<deadline:
            row=json.loads(self.call(
                "run","view",str(run_id),"-R","kody-w/openrappter",
                "--json","status,conclusion,event,headBranch,headSha,createdAt,databaseId",
            ))
            if not matching_release_runs([row],baseline,fresh_only=not bool(baseline["existing_matches"])):
                raise RuntimeError("release.yml run identity changed")
            if row["status"]=="completed":
                if row["conclusion"]!="success": raise RuntimeError(f"release.yml failed: {row['conclusion']}")
                final_rows=json.loads(self.call(
                    "run","list","-R","kody-w/openrappter","--workflow","release.yml",
                    "--branch",baseline["tag"],"--limit","100","--json",RELEASE_RUN_FIELDS,
                ))
                final=[*baseline["existing_matches"],*matching_release_runs(final_rows,baseline,fresh_only=True)]
                if len({item["databaseId"] for item in final})!=1:
                    raise RuntimeError("multiple release.yml runs match exact tag/source identity")
                return run_id
            time.sleep(5)
        raise RuntimeError("release.yml timed out")
    def api_json(self, endpoint: str) -> object:
        return json.loads(self.call("api", endpoint))
    def content(self, repo: str, path: str, ref: str="main") -> dict:
        value=self.api_json(f"repos/{repo}/contents/{path}?ref={ref}")
        return json.loads(base64.b64decode(value["content"]))
    def index(self, ring: str) -> dict: return self.content(TRAIN,f"request-index/{ring}.json")
    def head(self, ring: str) -> dict: return self.content(TRAIN,f"heads/{ring}.json")
    def request_commit(self, path: str) -> str:
        return self.api_json(f"repos/{TRAIN}/commits?path={path}&per_page=1")[0]["sha"]
    def stable_pr(self, request_id: str) -> dict:
        rows=self.api_json(f"repos/kody-w/openrappter/pulls?state=all&head=kody-w:ring/stable-{request_id[:16]}")
        if len(rows)!=1: raise RuntimeError("deterministic stable PR missing/ambiguous")
        return rows[0]
    def pages_configured(self) -> bool:
        return self.api_json("repos/kody-w/openrappter/pages").get("build_type") == "workflow"
    def artifact_sha(self, ring: str) -> str:
        head=self.head(ring)
        receipt=self.content(TRAIN,head["receipt_path"],head["authority_commit"])
        return receipt["artifact_sha256"]

class FakeGitHub:
    """Stateful fake: indexes begin empty and workflows alone mutate them."""
    def __init__(self, path: Path, allow_existing: bool = False):
        self.path=path
        self.state=json.loads(path.read_text())
        if not allow_existing and any(self.state["indexes"][ring]["entries"] for ring in RINGS):
            raise RuntimeError("fake backend must not prepopulate future indexes")
    def save(self): atomic_json(self.path,self.state)
    def workflow(self, repo: str, workflow: str, fields: dict[str,str]) -> None:
        if self.state.get("fail_workflow")==workflow: raise RuntimeError(f"{workflow} failed")
        self.state["calls"].append({"repo":repo,"workflow":workflow,"fields":fields})
        if workflow=="build-candidate.yml":
            self.state["candidate"]=True
            self.state["candidate_identity"]={
                "intended_release_tag":fields["intended_release_tag"],
                "source_commit":fields["source_commit"],
            }
        elif workflow=="observe-main.yml":
            if not self.state["candidate"]: raise RuntimeError("candidate missing")
            self._request("nightly")
        elif workflow=="request-promotion.yml":
            target=fields["target_ring"]; prior=RINGS[RINGS.index(target)-1]
            if self.state["heads"][prior]["sequence"]<2: raise RuntimeError("prior ring not finalized")
            self._request(target)
        elif workflow=="apply-promotion.yml":
            ring=repo.split("openrappter-")[-1] if repo!="kody-w/openrappter" else "stable"
            seq=int(fields["request_sequence"]); entry=self._entry(ring,seq)
            if seq!=self.state["heads"][ring]["sequence"]+1: raise RuntimeError("apply gap")
            self.state["acks"][ring]=entry
            if ring=="stable": self.state["stable_pr"]={"number":99,"merged_at":None,"merge_commit_sha":None,"request_id":entry["request_id"]}
        elif workflow=="finalize-promotion.yml":
            path=fields["request_path"]; ring=path.split("/")[1]; entry=self.state["acks"].get(ring)
            if not entry or entry["path"]!=path: raise RuntimeError("immutable acknowledgement missing")
            self.state["heads"][ring]={"sequence":entry["sequence"],"promotion_id":entry["request_id"],"target_manifest_commit":f"{entry['sequence']:040x}"}
        elif workflow=="pages.yml": self.state["pages"]=True
        elif workflow=="create-release-tag.yml":
            if self.state["heads"]["stable"]["sequence"]<2: raise RuntimeError("tag before stable")
            if self.state.get("tag_conclusion","success")!="success":
                raise RuntimeError(f"create-release-tag.yml failed: {self.state['tag_conclusion']}")
            if not self.state["tag"]:
                self.state["tag"]=True
                self.state["clock"]+=1
                self.state["release_runs"].extend(self.state.get("concurrent_release_runs",[]))
                identity=self.state["candidate_identity"]
                mode=self.state.get("release_mode","fast")
                run={
                    "databaseId":self.state["next_run_id"],
                    "status":"queued" if mode=="delayed" else "completed",
                    "conclusion":None if mode=="delayed" else ("success" if mode=="fast" else mode),
                    "event":"push",
                    "headBranch":identity["intended_release_tag"],
                    "headSha":identity["source_commit"],
                    "createdAt":self.state["clock"],
                }
                self.state["next_run_id"]+=1
                if mode=="delayed": self.state["pending_release"]=run
                else:
                    self.state["release_runs"].append(run)
                    self.state["released"]=mode=="fast"
        elif workflow=="release.yml":
            raise RuntimeError("release.yml must be started only by the release tag push")
        self.save()
    def release_baseline(self, tag: str, source_commit: str) -> dict:
        self.state["calls"].append({
            "repo":"kody-w/openrappter",
            "workflow":"release-baseline",
            "fields":{"tag":tag,"source_commit":source_commit,"captured_at":self.state["clock"]},
        })
        baseline={
            "run_ids":{row["databaseId"] for row in self.state["release_runs"]},
            "captured_at":self.state["clock"],
            "tag":tag,
            "source_commit":source_commit,
            "tag_existed":self.state["tag"],
        }
        existing=matching_release_runs(self.state["release_runs"],baseline,fresh_only=False)
        if baseline["tag_existed"] and len(existing)>1:
            raise RuntimeError("release.yml exact tag/source run is ambiguous")
        baseline["existing_matches"]=existing if baseline["tag_existed"] else []
        self.save()
        return baseline
    def wait_release(self, baseline: dict) -> int:
        pending=self.state.pop("pending_release",None)
        if pending:
            pending["status"]="completed";pending["conclusion"]="success"
            self.state["release_runs"].append(pending)
        fresh=matching_release_runs(self.state["release_runs"],baseline,fresh_only=True)
        candidates=[*baseline["existing_matches"],*fresh]
        if len(candidates)>1: raise RuntimeError("multiple release.yml runs match exact tag/source identity")
        if not candidates: raise RuntimeError("release.yml exact tag/source run did not appear")
        run=candidates[0]
        if run["status"]!="completed": raise RuntimeError("release.yml timed out")
        if run["conclusion"]!="success": raise RuntimeError(f"release.yml failed: {run['conclusion']}")
        self.state["released"]=True
        self.save()
        return run["databaseId"]
    def _request(self,ring):
        index=self.state["indexes"][ring]; seq=index["next_sequence"]; rid=f"{seq:064x}"
        entry={"sequence":seq,"request_id":rid,"path":f"requests/{ring}/{seq:020d}-{rid}.json","request_commit":f"{seq+100:040x}"}
        index["entries"].append(entry); index["next_sequence"]+=1
    def _entry(self,ring,seq):
        rows=[e for e in self.state["indexes"][ring]["entries"] if e["sequence"]==seq]
        if len(rows)!=1: raise RuntimeError("stale/missing request index")
        return rows[0]
    def index(self,ring): return self.state["indexes"][ring]
    def head(self,ring): return self.state["heads"][ring]
    def request_commit(self,path):
        for index in self.state["indexes"].values():
            for row in index["entries"]:
                if row["path"]==path:return row["request_commit"]
        raise RuntimeError("request path missing")
    def stable_pr(self,request_id): return self.state["stable_pr"]
    def pages_configured(self): return self.state.get("pages_configured",False)
    def artifact_sha(self,ring): return self.state["heads"][ring].get("artifact_sha256","a"*64)

def latest_request(gh, ring: str, expected_sequence: int) -> tuple[dict,str]:
    index=gh.index(ring)
    if index.get("schema")!="openrappter-request-index/v1": raise RuntimeError("request index schema mismatch")
    rows=[row for row in index["entries"] if row["sequence"]==expected_sequence]
    if len(rows)!=1: raise RuntimeError("stale index or missing exact request sequence")
    row=rows[0]
    return row,gh.request_commit(row["path"])

def process_ring(gh, checkpoint: dict, ring: str, source_ring: str|None=None) -> None:
    if source_ring:
        source=gh.head(source_ring)
        source_repo=f"kody-w/openrappter-{source_ring}"
        url=f"https://raw.githubusercontent.com/{source_repo}/{source['target_manifest_commit']}/.ring/manifest.json"
        gh.workflow(TRAIN,"request-promotion.yml",{"source_manifest_url":url,"target_ring":ring})
    expected=gh.head(ring)["sequence"]+1
    request,commit=latest_request(gh,ring,expected)
    repo="kody-w/openrappter" if ring=="stable" else f"kody-w/openrappter-{ring}"
    gh.workflow(repo,"apply-promotion.yml",{"request_sequence":str(expected)})
    checkpoint["rings"][ring]={"sequence":expected,"request_id":request["request_id"],"request_path":request["path"],"request_commit":commit}
    if ring=="stable":
        checkpoint["phase"]="stable_review"
        checkpoint["stable_pr"]=gh.stable_pr(request["request_id"])
        return
    gh.workflow(TRAIN,"finalize-promotion.yml",{"request_commit":commit,"request_path":request["path"]})
    head=gh.head(ring)
    if head["sequence"]!=expected or head["promotion_id"]!=request["request_id"]: raise RuntimeError(f"{ring} head did not finalize exact request")
    checkpoint["phase"]=f"{ring}_finalized"

def run(args) -> int:
    root=Path(args.root)
    checkpoint=Path(args.checkpoint or Path(os.environ.get("OPENRAPPTER_HOME",Path.home()/".openrappter"))/"release-journey.json")
    gh=FakeGitHub(Path(args.fixtures)/"state.json", allow_existing=args.resume) if args.dry_run else LiveGitHub(args.timeout)
    if args.resume:
        if not checkpoint.exists(): raise RuntimeError("resume checkpoint missing")
        state=json.loads(checkpoint.read_text())
        if state.get("phase")!="stable_review": raise RuntimeError("checkpoint is not waiting for stable review")
        pr=gh.stable_pr(state["rings"]["stable"]["request_id"])
        if not pr.get("merged_at") or not pr.get("merge_commit_sha"): raise RuntimeError("stable PR is not merged")
        expected=state["stable_pr"]
        if expected.get("number")!=pr.get("number"): raise RuntimeError("resume stable PR mismatch")
        item=state["rings"]["stable"]
        gh.workflow(TRAIN,"finalize-promotion.yml",{"request_commit":item["request_commit"],"request_path":item["request_path"]})
        head=gh.head("stable")
        if head["sequence"]!=item["sequence"] or head["promotion_id"]!=item["request_id"]: raise RuntimeError("stable authority head mismatch")
        if not gh.pages_configured(): raise RuntimeError("Pages is not configured for workflow deployment")
        if gh.artifact_sha("beta") != gh.artifact_sha("stable"):
            raise RuntimeError("beta/stable candidate digest mismatch")
        gh.workflow("kody-w/openrappter","pages.yml",{})
        release_baseline=gh.release_baseline(state["intended_release_tag"],state["source_commit"])
        gh.workflow("kody-w/openrappter","create-release-tag.yml",{})
        release_run_id=gh.wait_release(release_baseline)
        state["phase"]="complete";state["stable_merge_commit"]=pr["merge_commit_sha"];state["release_run_id"]=release_run_id;atomic_json(checkpoint,state)
        return 0
    if checkpoint.exists(): raise RuntimeError("journey checkpoint exists; use --resume")
    npm=json.loads((root/"typescript/package.json").read_text())["version"]
    import tomllib
    pypi=tomllib.loads((root/"python/pyproject.toml").read_text())["project"]["version"]
    runtime=subprocess.check_output([sys.executable,"-c","import sys;sys.path.insert(0,'python');from openrappter import __version__;print(__version__)"],cwd=root,text=True).strip()
    source=subprocess.check_output(["git","rev-parse","HEAD"],cwd=root,text=True).strip()
    intended=f"v{npm}"
    state={"schema":"openrappter-release-journey/v1","phase":"start","source_commit":source,"versions":{"npm":npm,"pypi":pypi,"runtime":runtime,"channel":args.channel_version},"intended_release_tag":intended,"rings":{}}
    atomic_json(checkpoint,state)
    gh.workflow("kody-w/openrappter","build-candidate.yml",{"source_commit":source,"channel_version":args.channel_version,"intended_release_tag":intended,"candidate_kind":"release"})
    gh.workflow(TRAIN,"observe-main.yml",{"candidate_kind":"release","candidate_id":tag_candidate_id(intended)})
    process_ring(gh,state,"nightly");atomic_json(checkpoint,state)
    for source_ring,ring in (("nightly","alpha"),("alpha","canary"),("canary","beta")):
        process_ring(gh,state,ring,source_ring);atomic_json(checkpoint,state)
    process_ring(gh,state,"stable","beta");atomic_json(checkpoint,state)
    print(f"Stable PR #{state['stable_pr']['number']} requires review, checks, and merge; then run --resume")
    return 0

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--root",required=True);parser.add_argument("--channel-version")
    parser.add_argument("--checkpoint");parser.add_argument("--resume",action="store_true")
    parser.add_argument("--dry-run",action="store_true");parser.add_argument("--fixtures")
    parser.add_argument("--timeout",type=int,default=1800)
    args=parser.parse_args()
    if not args.resume and not args.channel_version: parser.error("--channel-version is required")
    if args.dry_run and not args.fixtures: parser.error("--dry-run requires --fixtures")
    try:return run(args)
    except Exception as exc:print(f"release journey: {exc}",file=sys.stderr);return 1
if __name__=="__main__":raise SystemExit(main())
