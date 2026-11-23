"""Client asynchrone pour la passerelle matérielle locale UART / RS485."""
from typing import Any


class LocalGatewayClient:
    """Client asynchrone pour la passerelle matérielle locale UART/RS485."""

    def __init__(self, default_timeout: float = 6.0):
        self.default_timeout = default_timeout

    async def test_connection(self, gateway_url: str) -> dict[str, Any]:
        """Teste la joignabilité de la passerelle locale."""
        import clients as _clients_pkg

        url = (gateway_url or "http://192.168.1.150").rstrip("/")
        async with _clients_pkg.borrow_http_client(timeout=5.0) as client:
            resp = await client.get(f"{url}/status", timeout=5.0)
            resp.raise_for_status()
            return resp.json()

    async def read_buffer(self, gateway_url: str) -> dict[int, float]:
        """Interroge le buffer d'états de la passerelle locale."""
        import clients as _clients_pkg

        url = (gateway_url or "http://192.168.1.150").rstrip("/")
        async with _clients_pkg.borrow_http_client(timeout=self.default_timeout) as client:
            resp = await client.get(f"{url}/status", timeout=self.default_timeout)
            resp.raise_for_status()
            gw_data = resp.json()
            return {int(k): float(v) for k, v in gw_data.items() if str(k).isdigit()}

    async def write_registers(self, gateway_url: str, commands: list[dict[str, Any]]) -> None:
        """Envoie une liste d'écritures de registres vers la passerelle locale."""
        import clients as _clients_pkg

        url = (gateway_url or "http://192.168.1.150").rstrip("/")
        async with _clients_pkg.borrow_http_client(timeout=8.0) as client:
            for c in commands:
                resp = await client.post(
                    f"{url}/write",
                    json={"offset": c["offset"], "reg_key": c["reg_key"], "value": c["new_val"]},
                    timeout=8.0,
                )
                resp.raise_for_status()


local_gateway_client = LocalGatewayClient()
