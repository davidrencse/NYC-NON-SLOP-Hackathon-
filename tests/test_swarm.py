import asyncio
import json
import os
import unittest
from unittest import mock

from fastapi.testclient import TestClient

from forge_research.agents import swarm
from forge_research.studio import app

os.environ.setdefault("FORGE_ENCLOSURE", "off")  # skip the CadQuery enclosure job in fast tests


class SwarmOfflineTest(unittest.TestCase):
    def test_offline_swarm_emits_every_step(self) -> None:
        events: list[dict] = []
        report = asyncio.run(swarm.run_swarm("EMG band", live=False, emit=events.append))
        self.assertEqual(report.engine, "offline")
        self.assertEqual(report.status, "completed")
        self.assertEqual([a.role for a in report.agents], [r.id for r in swarm.ROLES])
        kinds = [e["event"] for e in events]
        self.assertEqual(kinds[0], "start")
        self.assertEqual(kinds[-1], "complete")
        self.assertIn("synthesis", kinds)
        done = [e for e in events if e["event"] == "agent" and e["status"] == "completed"]
        self.assertEqual(len(done), len(swarm.ROLES))
        self.assertTrue(all(e["type"] == "swarm" for e in events))

    def test_live_without_key_falls_back_to_offline(self) -> None:
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "", "GOOGLE_API_KEY": "", "ANTHROPIC_API_KEY": ""}):
            report = asyncio.run(swarm.run_swarm("brief", live=True))
        self.assertEqual(report.engine, "offline")

    def test_build_tasks_include_brief(self) -> None:
        tasks = swarm.build_tasks("a wristband")
        self.assertEqual(len(tasks), len(swarm.ROLES))
        self.assertTrue(all("a wristband" in t["context"] for t in tasks))

    def test_sample_stream_includes_swarm_before_report(self) -> None:
        client = TestClient(app)
        with client.stream("POST", "/api/research/stream", json={"mode": "sample"}) as response:
            self.assertEqual(response.status_code, 200)
            lines = [json.loads(line) for line in response.iter_lines() if line.strip()]
        types = [line["type"] for line in lines]
        self.assertIn("swarm", types)
        self.assertEqual(types[-1], "report")
        self.assertLess(types.index("swarm"), types.index("report"))
        final = lines[-1]["report"]
        self.assertEqual(final["swarm"]["engine"], "offline")
        self.assertEqual(final["swarm"]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
