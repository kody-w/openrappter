import json
import unittest

import autopilot


INVENTORY = json.dumps(
    {
        "devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
                {
                    "name": "iPhone 17 Pro",
                    "udid": "BAD303DC-6F41-4FBF-ACFE-7BC6AA68E3FC",
                    "state": "Booted",
                    "isAvailable": True,
                },
                {
                    "name": "iPhone 17",
                    "udid": "B1676551-63B6-4A19-A91F-EB4B2F8CFAD3",
                    "state": "Shutdown",
                    "isAvailable": True,
                },
            ],
            "com.apple.CoreSimulator.SimRuntime.watchOS-26-5": [
                {
                    "name": "iPhone 17 Pro",
                    "udid": "NOT-AN-IOS-DEVICE",
                    "state": "Booted",
                    "isAvailable": True,
                }
            ],
        }
    }
)


class DeviceResolutionTests(unittest.TestCase):
    def test_names_match_exactly_not_by_substring(self):
        record = autopilot.device_record(INVENTORY, "iPhone 17")
        self.assertEqual(record["udid"], "B1676551-63B6-4A19-A91F-EB4B2F8CFAD3")
        self.assertEqual(record["state"], "Shutdown")

    def test_udids_match_case_insensitively(self):
        record = autopilot.device_record(
            INVENTORY,
            "bad303dc-6f41-4fbf-acfe-7bc6aa68e3fc",
        )
        self.assertEqual(record["name"], "iPhone 17 Pro")

    def test_non_ios_runtimes_are_not_candidates(self):
        record = autopilot.device_record(INVENTORY, "iPhone 17 Pro")
        self.assertNotEqual(record["udid"], "NOT-AN-IOS-DEVICE")

    def test_partial_names_are_refused(self):
        with self.assertRaises(autopilot.AutopilotError):
            autopilot.device_record(INVENTORY, "iPhone")


if __name__ == "__main__":
    unittest.main()
