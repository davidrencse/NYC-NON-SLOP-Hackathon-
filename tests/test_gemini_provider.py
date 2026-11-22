import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from forge_research.providers.keys import FIELDS, PROVIDERS, KeyUpdate, integrations_status, update_keys, load_saved_keys
from forge_research.providers.defaults import DEFAULT_GEMINI_MODEL
from forge_research.providers.llm import live_model


class GeminiProviderTests(unittest.TestCase):
    def test_key_alone_enables_argon_without_model_discovery(self):
        with patch.dict(os.environ, {}, clear=True):
            status = update_keys(KeyUpdate(gemini_api_key="test-key"))
            self.assertTrue(status["providers"]["gemini"]["configured"])
            self.assertEqual(status["fields"]["gemini_model"]["hint"], DEFAULT_GEMINI_MODEL)
            self.assertEqual(live_model().name, DEFAULT_GEMINI_MODEL)

    def test_shell_key_also_uses_default_without_enabling_keyless_live_mode(self):
        for key in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
            with self.subTest(key=key), patch.dict(os.environ, {key: "test-key"}, clear=True):
                self.assertEqual(live_model().name, DEFAULT_GEMINI_MODEL)
                self.assertTrue(integrations_status()["providers"]["gemini"]["configured"])
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(live_model())
            self.assertFalse(integrations_status()["providers"]["gemini"]["configured"])

    def test_custom_choice_survives_key_replacement_and_remember_reload(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True), patch(
            "forge_research.providers.keys.KEYS_FILE", Path(directory) / "keys.local"
        ):
            update_keys(KeyUpdate(gemini_api_key="first-test-key", gemini_model="gemini-custom"))
            update_keys(KeyUpdate(gemini_api_key="replacement-key", remember=True))
            self.assertEqual(live_model().name, "gemini-custom")
            os.environ.clear()
            load_saved_keys()
            self.assertEqual(live_model().name, "gemini-custom")

    def test_default_is_remembered_and_can_be_changed_later(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True), patch(
            "forge_research.providers.keys.KEYS_FILE", Path(directory) / "keys.local"
        ):
            update_keys(KeyUpdate(gemini_api_key="test-key", remember=True))
            os.environ.clear()
            load_saved_keys()
            self.assertEqual(live_model().name, DEFAULT_GEMINI_MODEL)
            update_keys(KeyUpdate(gemini_model="gemini-another"))
            self.assertEqual(live_model().name, "gemini-another")

    def test_legacy_nous_configuration_cannot_enable_live_research(self):
        with patch.dict(os.environ, {"NOUS_API_KEY": "legacy-key", "FORGE_LLM_PROVIDER": "nous"}, clear=True):
            self.assertIsNone(live_model())
            status = integrations_status()
            self.assertNotIn("nous", status["providers"])
            self.assertNotIn("nous_api_key", status["fields"])

    def test_gemini_is_selected_even_with_a_legacy_nous_preference(self):
        with patch.dict(os.environ, {"NOUS_API_KEY": "legacy-key", "FORGE_LLM_PROVIDER": "nous", "GEMINI_API_KEY": "test-key", "FORGE_GEMINI_MODEL": "gemini-test"}, clear=True):
            model = live_model()
            self.assertEqual(model.mode, "gemini")
            self.assertEqual(model.adk_model(), "gemini-test")
            self.assertTrue(integrations_status()["providers"]["gemini"]["configured"])

    def test_key_setup_exposes_only_current_providers(self):
        self.assertEqual(set(PROVIDERS), {"gemini", "reducto", "pangram", "modal"})
        self.assertFalse(any("nous" in field for field in FIELDS))
        self.assertNotIn("nous_api_key", KeyUpdate.model_fields)


if __name__ == "__main__":
    unittest.main()
