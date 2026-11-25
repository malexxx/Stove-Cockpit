import unittest
from schemas import (
    CommandPayload,
    BatchCommandPayload,
    RefillHopperPayload,
    SettingsPayload,
    MatterWebhookPayload,
    ClientErrorPayload,
)


class TestSchemas(unittest.TestCase):
    def test_command_payload_valid(self):
        cmd = CommandPayload(reg_key="power_level", value=4.0, offset=33120)
        self.assertEqual(cmd.reg_key, "power_level")
        self.assertEqual(cmd.value, 4.0)
        self.assertEqual(cmd.offset, 33120)

    def test_batch_command_payload(self):
        batch = BatchCommandPayload(
            commands=[
                CommandPayload(reg_key="power_level", value=4.0),
                CommandPayload(reg_key="fan_front_speed", value=3.0),
            ]
        )
        self.assertEqual(len(batch.commands), 2)

    def test_refill_hopper_payload_defaults(self):
        payload = RefillHopperPayload()
        self.assertEqual(payload.bags_added, 2.0)
        self.assertEqual(payload.target_pct, 100.0)

    def test_settings_payload_coercion(self):
        settings = SettingsPayload(
            comm_mode="simulation",
            poll_interval_s="60",
            pellet_bags_stock=40,
            matter_enabled=True,
        )
        data = settings.model_dump(exclude_none=True)
        self.assertEqual(data["comm_mode"], "simulation")
        self.assertEqual(data["poll_interval_s"], "60")

    def test_settings_payload_cockpit_ui_mode(self):
        settings = SettingsPayload(cockpit_ui_mode="bento")
        data = settings.model_dump(exclude_none=True)
        self.assertEqual(data["cockpit_ui_mode"], "bento")

    def test_matter_webhook_payload(self):
        p_power = MatterWebhookPayload(action="set_power", state="ON")
        self.assertEqual(p_power.action, "set_power")
        self.assertEqual(p_power.state, "ON")

        p_temp = MatterWebhookPayload(action="set_temperature", temperature=21.5)
        self.assertEqual(p_temp.temperature, 21.5)

    def test_client_error_payload_defaults(self):
        err = ClientErrorPayload()
        self.assertEqual(err.severity, "ERROR")
        self.assertEqual(err.source, "FRONTEND")
        self.assertEqual(err.message, "Erreur interface")


if __name__ == "__main__":
    unittest.main()
