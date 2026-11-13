import importlib.util
import pathlib
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ModeSafetyTests(unittest.TestCase):
    def test_slash_helpers_refuse_before_any_send(self):
        for module, name in ((load('reconcile_mode', 'reconcile-mode.py'), 'slash'),
                             (load('propagate_mode', 'propagate-mode-change.py'), 'send_slash')):
            with self.subTest(name=name), patch.object(module, 'run') as run:
                with self.assertRaises(RuntimeError):
                    getattr(module, name)('w1:p1', '/profile reload', None)
                run.assert_not_called()

    def test_direct_mutation_paths_refuse(self):
        r = load('reconcile_mode2', 'reconcile-mode.py')
        p = load('propagate_mode2', 'propagate-mode-change.py')
        with self.assertRaises(RuntimeError):
            r.reconcile('w1:p1', 'lane', False, True)
        with self.assertRaises(RuntimeError):
            p.deliver('w1:p1', 'profile', 'leader', False)


if __name__ == '__main__':
    unittest.main()
