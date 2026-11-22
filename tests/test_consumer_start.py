import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('consumer_start', Path(__file__).resolve().parents[1] / 'scripts/consumer-start.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def test_either_child_exit_is_detected_without_waiting_for_other(self):
        for index in (0, 1):
            children = [('backend', Mock()), ('frontend', Mock())]
            for _, child in children:
                child.poll.return_value = None
            children[index][1].poll.return_value = 1
            self.assertEqual(launcher.wait_for_exit(children), (children[index][0], 1))
            for _, child in children:
                child.wait.assert_not_called()

    def test_main_reports_failure_and_stops_both_owned_children(self):
        backend, frontend = Mock(pid=12345), Mock(pid=12346)
        backend.poll.return_value = 1
        with patch('sys.argv', ['consumer-start.py', '--env-file', '/unused', '--hermes-source', '/tmp/hermes']), patch.object(launcher, 'dotenv_values', return_value={}), patch.object(launcher.subprocess, 'Popen', side_effect=[backend, frontend]), patch.object(launcher.os, 'killpg') as kill:
            with self.assertRaisesRegex(SystemExit, 'Python backend exited unexpectedly.*port conflicts'):
                launcher.main()
        self.assertEqual(kill.call_count, 2)
        backend.wait.assert_called_once_with(timeout=5)
        frontend.wait.assert_called_once_with(timeout=5)

    def test_cleanup_targets_only_owned_children(self):
        child = Mock(pid=12345)
        with patch.object(launcher.os, 'killpg') as kill:
            launcher.stop_children([('backend', child)])
        kill.assert_called_once_with(12345, launcher.signal.SIGTERM)
        child.wait.assert_called_once_with(timeout=5)
