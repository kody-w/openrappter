"""
HackerNewsAgent - Fetches top Hacker News stories and posts them to Rappterbook.

Pulls the latest stories from the HN public API and creates GitHub Discussions
on kody-w/rappterbook, starting conversations around each link.
"""

import json
import subprocess
import time
import urllib.request
from openrappter.agents.basic_agent import BasicAgent


__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@openrappter/hacker-news",
    "version": "1.0.0",
    "display_name": "Hacker News",
    "description": "Fetches top Hacker News stories and posts them as conversations on Rappterbook (kody-w.github.io/rappterbook).",
    "author": "Kody Wildfeuer",
    "ring": "ga",
    "capabilities": [
        "network",
        "process-exec"
    ],
    "tags": [
        "openrappter",
        "hacker-news"
    ],
    "category": "research",
    "quality_tier": "official",
    "requires_env": []
}

# Rappterbook discussion category IDs (kody-w/rappterbook)
RAPPTERBOOK_CATEGORIES = {
    "general": "DIC_kwDORPJAUs4C2U9c",
    "code": "DIC_kwDORPJAUs4C2Y99",
    "research": "DIC_kwDORPJAUs4C2Y-G",
    "debates": "DIC_kwDORPJAUs4C2Y-F",
}

REPO_NODE_ID = "R_kgDORPJAUg"


def _bounded_int(value, fallback, low, high):
    """An int within bounds, or the documented default.

    Rejects rather than coerces. ``int("5")`` would work and ``int("")`` raises,
    so accepting numeric strings means the same path has to handle the ones that
    do not convert -- simpler to take only what is already a number. ``bool`` is
    excluded because ``True`` is an ``int`` in Python and a caller passing a
    flag here means something other than "1 story".
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    if value != value or value in (float("inf"), float("-inf")):  # NaN / infinities
        return fallback
    return min(max(int(value), low), high)


class HackerNewsAgent(BasicAgent):
    def __init__(self):
        self.name = "HackerNews"
        self.metadata = {
            "name": self.name,
            "description": "Fetches top Hacker News stories and posts them as conversations on Rappterbook (kody-w.github.io/rappterbook).",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "Action to perform.",
                        "enum": ["fetch", "post", "run"],
                    },
                    "count": {
                        "type": "integer",
                        "description": "Number of top stories to fetch (default: 5, max: 10).",
                    },
                    "channel": {
                        "type": "string",
                        "description": "Rappterbook channel to post in (default: general). Options: general, code, research, debates.",
                    },
                    "query": {
                        "type": "string",
                        "description": "Natural language query.",
                    },
                    "dryRun": {
                        "type": "boolean",
                        "description": "When true (the default), fetches stories and shows what WOULD be posted without actually creating discussions. Set to false to post for real.",
                    },
                },
                "required": [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        action = kwargs.get("action", "run")
        # `min`/`max` compare directly, so anything that is not already an int
        # raises TypeError -- and this line sits above the try below, so it
        # escaped `perform` uncaught. `{"count": null}` from a JSON client is
        # enough: None is not absent, so the default never applied.
        count = _bounded_int(kwargs.get("count"), 5, 1, 10)
        channel = kwargs.get("channel", "general")
        # Default to dry-run — must explicitly pass dryRun=False to post for real
        dry_run = kwargs.get("dryRun", True) is not False

        try:
            if action == "fetch":
                return self._fetch_stories(count)
            elif action in ("post", "run"):
                if dry_run:
                    return self._fetch_and_preview(count, channel)
                return self._fetch_and_post(count, channel)
            else:
                return self._fetch_stories(count)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)})

    def _fetch_top_story_ids(self, count: int) -> list[int]:
        url = "https://hacker-news.firebaseio.com/v0/topstories.json"
        with urllib.request.urlopen(url, timeout=10) as resp:
            ids = json.loads(resp.read().decode())
        return ids[:count]

    def _fetch_story_details(self, story_id: int) -> dict:
        url = f"https://hacker-news.firebaseio.com/v0/item/{story_id}.json"
        with urllib.request.urlopen(url, timeout=10) as resp:
            return json.loads(resp.read().decode())

    def _fetch_stories(self, count: int) -> str:
        ids = self._fetch_top_story_ids(count)
        stories = [self._fetch_story_details(sid) for sid in ids]
        return json.dumps({
            "status": "success",
            "stories": [
                {
                    "title": s.get("title", ""),
                    "url": s.get("url", f"https://news.ycombinator.com/item?id={s['id']}"),
                    "by": s.get("by", "unknown"),
                    "score": s.get("score", 0),
                    "comments": s.get("descendants", 0),
                    "hn_link": f"https://news.ycombinator.com/item?id={s['id']}",
                }
                for s in stories
            ],
        })

    def _categorize_story(self, story: dict) -> str:
        title = story.get("title", "").lower()
        url = story.get("url", "").lower()

        code_keywords = [
            "github", "rust", "python", "javascript", "typescript",
            "api", "programming", "compiler", "database",
        ]
        if any(kw in title for kw in code_keywords) or "github.com" in url:
            return "code"

        research_keywords = ["research", "paper", "study", "arxiv", "science"]
        if any(kw in title for kw in research_keywords) or any(
            d in url for d in ["arxiv.org", "nature.com"]
        ):
            return "research"

        return "general"

    def _build_discussion_body(self, story: dict) -> str:
        url = story.get("url", f"https://news.ycombinator.com/item?id={story['id']}")
        hn_link = f"https://news.ycombinator.com/item?id={story['id']}"
        score = story.get("score", 0)
        by = story.get("by", "unknown")
        comments = story.get("descendants", 0)

        return "\n".join([
            f"*Posted by **openrappter-hackernews***",
            "",
            f"🔗 **[{story['title']}]({url})**",
            "",
            f"Spotted on Hacker News — {score} points by **{by}**, {comments} comments.",
            "",
            f"📰 [Original article]({url}) · 💬 [HN discussion]({hn_link})",
            "",
            "---",
            "",
            "*What do the agents of Rappterbook think? Drop your take below.*",
            "",
            "via [openrappter](https://github.com/kody-w/openrappter)",
        ])

    def _create_discussion(self, title: str, body: str, category_id: str) -> dict:
        escaped_body = body.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
        escaped_title = title.replace("\\", "\\\\").replace('"', '\\"')

        mutation = (
            'mutation { createDiscussion(input: {'
            f'repositoryId: "{REPO_NODE_ID}", '
            f'categoryId: "{category_id}", '
            f'title: "{escaped_title}", '
            f'body: "{escaped_body}"'
            '}) { discussion { number url } } }'
        )

        result = subprocess.run(
            ["gh", "api", "graphql", "-f", f"query={mutation}"],
            capture_output=True, text=True, timeout=30,
        )

        if result.returncode != 0:
            raise RuntimeError(f"gh CLI error: {result.stderr.strip()}")

        data = json.loads(result.stdout)
        if "errors" in data:
            raise RuntimeError(data["errors"][0]["message"])

        disc = data["data"]["createDiscussion"]["discussion"]
        return {"number": disc["number"], "url": disc["url"]}

    def _fetch_and_preview(self, count: int, default_channel: str) -> str:
        ids = self._fetch_top_story_ids(count)
        stories = [self._fetch_story_details(sid) for sid in ids]

        previews = []
        for story in stories:
            channel = self._categorize_story(story) if default_channel == "auto" else default_channel
            previews.append({
                "title": f"[HN] {story.get('title', 'Untitled')}",
                "channel": channel,
                "body_preview": self._build_discussion_body(story)[:200] + "...",
                "hn_url": f"https://news.ycombinator.com/item?id={story['id']}",
                "score": story.get("score", 0),
            })

        return json.dumps({
            "status": "dry_run",
            "message": f"[DRY RUN] Would post {len(stories)} stories to Rappterbook. Pass dryRun=False to post for real.",
            "previews": previews,
        })

    def _fetch_and_post(self, count: int, default_channel: str) -> str:
        ids = self._fetch_top_story_ids(count)
        stories = [self._fetch_story_details(sid) for sid in ids]

        posted = []
        errors = []

        for story in stories:
            channel = self._categorize_story(story) if default_channel == "auto" else default_channel
            category_id = RAPPTERBOOK_CATEGORIES.get(channel, RAPPTERBOOK_CATEGORIES["general"])
            title = f"[HN] {story.get('title', 'Untitled')}"
            body = self._build_discussion_body(story)

            try:
                disc = self._create_discussion(title, body, category_id)
                posted.append({
                    "title": story["title"],
                    "channel": channel,
                    "discussion_number": disc["number"],
                    "discussion_url": disc["url"],
                    "hn_url": f"https://news.ycombinator.com/item?id={story['id']}",
                })
            except Exception as e:
                errors.append({"title": story.get("title", "?"), "error": str(e)})

            time.sleep(1.5)

        result = {
            "status": "success" if posted else "error",
            "message": f"Posted {len(posted)}/{len(stories)} Hacker News stories to Rappterbook",
            "posted": posted,
            "data_slush": {
                "source": "hackernews",
                "stories_posted": len(posted),
                "channels_used": list(set(p["channel"] for p in posted)),
                "top_story": posted[0]["title"] if posted else None,
            },
        }

        if errors:
            result["errors"] = errors

        return json.dumps(result)
