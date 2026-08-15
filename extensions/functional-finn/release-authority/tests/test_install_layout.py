from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


@unittest.skipIf(os.name == "nt", "shell-plan behavior is validated on Moira")
class InstallLayoutTest(unittest.TestCase):
    def setUp(self) -> None:
        self.script = Path(__file__).parents[1] / "deployment" / "install-layout.sh"

    def run_plan(self, fake_dscl: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "dscl"
            binary.write_text("#!/bin/sh\n" + fake_dscl, encoding="utf-8")
            binary.chmod(0o755)
            environment = dict(os.environ)
            environment["PATH"] = directory + os.pathsep + environment["PATH"]
            environment["RELEASE_ID"] = "release-test-001"
            return subprocess.run(
                ["sh", str(self.script), "plan"],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )

    def test_safe_plan_checks_all_ids_before_printing_mutations(self) -> None:
        result = self.run_plan('if [ "$2" = "-read" ]; then exit 1; fi\nexit 0\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PLAN: dscl", result.stdout)

    def test_uid_collision_fails_before_any_plan_output(self) -> None:
        result = self.run_plan(
            'if [ "$2" = "-read" ]; then exit 1; fi\n'
            'if [ "$2" = "-search" ] && [ "$5" = "470" ]; then echo "_occupied 470"; fi\n'
            'exit 0\n'
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("already owned", result.stderr)
        self.assertNotIn("PLAN:", result.stdout)

    def test_existing_identity_with_wrong_id_fails_before_plan(self) -> None:
        result = self.run_plan(
            'if [ "$2" = "-read" ] && [ "$3" = "/Groups/_finnrel" ]; then\n'
            '  echo "PrimaryGroupID: 999"; exit 0;\n'
            'fi\n'
            'if [ "$2" = "-read" ]; then exit 1; fi\n'
            'exit 0\n'
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected 470", result.stderr)
        self.assertNotIn("PLAN:", result.stdout)


if __name__ == "__main__":
    unittest.main()
