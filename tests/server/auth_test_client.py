"""Authenticated TestClient for existing server route integration tests."""

from __future__ import annotations

from fastapi.testclient import TestClient as FastAPITestClient


class AuthenticatedTestClient(FastAPITestClient):
    """Create a test user for app-factory clients without bypassing middleware."""

    def __init__(self, app, *args, **kwargs):
        super().__init__(app, *args, **kwargs)
        if getattr(app.state, "auth_store", None) is None:
            return
        response = self.post(
            "/auth/register",
            json={"name": "route-test-user", "password": "route-test-password"},
        )
        if response.status_code not in {200, 201, 409}:
            raise RuntimeError(
                f"Could not authenticate test client: HTTP {response.status_code}"
            )
        response = self.post(
            "/auth/login",
            json={"name": "route-test-user", "password": "route-test-password"},
        )
        if response.status_code != 200:
            raise RuntimeError(
                f"Could not authenticate test client: HTTP {response.status_code}"
            )
