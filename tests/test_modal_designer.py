"""Inference must be skipped before CAD work for repeated Modal designs."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from modal_workers.designer import design_body


class ModalDesignCacheTests(unittest.TestCase):
    def test_repeat_skips_inference_but_layout_and_model_changes_do_not(self):
        response = Mock(status_code=200)
        response.json.return_value = {
            "content": [{"type": "text", "text": '{"parts":[{"shape":"box","mat":"metal","size":[120,4,160],"pos":[0,-2,0]}]}'}],
            "usage": {"input_tokens": 10, "output_tokens": 20},
        }
        with tempfile.TemporaryDirectory() as folder, patch("httpx.post", return_value=response) as post:
            options = {"api_key": "unit-test-key", "model": "fast-test-model", "cache_dir": Path(folder)}
            system = {"pcbHeight": 12, "devices": []}
            first = design_body("origami folding rig", system, **options)
            second = design_body("origami folding rig", system, **options)
            self.assertFalse(first["cache_hit"])
            self.assertTrue(second["cache_hit"])
            self.assertEqual(first["parts"], second["parts"])
            self.assertEqual(post.call_count, 1)
            self.assertEqual(post.call_args.kwargs["timeout"], 60)
            design_body("origami folding rig", {**system, "pcbHeight": 20}, **options)
            self.assertEqual(post.call_count, 2)
            design_body("origami folding rig", system, **{**options, "model": "other-model"})
            self.assertEqual(post.call_count, 3)

    def test_invalid_answers_are_not_cached(self):
        response = Mock(status_code=200)
        response.json.return_value = {"content": [{"type": "text", "text": '{"parts":[]}'}], "usage": {}}
        with tempfile.TemporaryDirectory() as folder, patch("httpx.post", return_value=response) as post:
            for _ in range(2):
                design_body("origami rig", {}, api_key="unit-test-key", model="fast", cache_dir=Path(folder))
            self.assertEqual(post.call_count, 2)
            self.assertEqual(list(Path(folder).glob("*.json")), [])


if __name__ == "__main__":
    unittest.main()
