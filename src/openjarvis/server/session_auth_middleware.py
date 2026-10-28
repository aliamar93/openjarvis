"""Default-deny session authentication for the FastAPI HTTP surface."""

from __future__ import annotations

from pathlib import Path

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse

from openjarvis.server.auth_store import SESSION_COOKIE_NAME, AuthStore

_PUBLIC_AUTH_PATHS = {
    "/auth/register",
    "/auth/login",
    "/auth/logout",
    "/auth/me",
}
_PUBLIC_HEALTH_PATHS = {"/health"}
_PUBLIC_STATIC_PATHS = {
    "/",
    "/favicon.ico",
    "/manifest.webmanifest",
    "/registerSW.js",
    "/sw.js",
    "/workbox-*.js",
    "/jarvis",
    "/settings",
    "/get-started",
    "/data-sources",
    "/agents",
    "/logs",
}
_PROTECTED_NON_API_PATHS = {
    "/metrics",
    "/openapi.json",
    "/docs",
    "/redoc",
}


class SessionAuthMiddleware(BaseHTTPMiddleware):
    """Require a valid user session on every non-public HTTP request."""

    def __init__(
        self,
        app,
        *,
        store: AuthStore,
        allowed_origins: list[str],
    ) -> None:
        super().__init__(app)
        self._store = store
        self._allowed_origins = frozenset(allowed_origins)

    async def dispatch(self, request: Request, call_next):  # noqa: ANN001
        if self._is_cors_preflight(request):
            return await call_next(request)
        if not self._origin_is_allowed(request):
            return JSONResponse(
                {"detail": "Origem não permitida."},
                status_code=403,
            )
        if request.url.path == "/auth/me":
            user = self._store.get_user_for_token(
                request.cookies.get(SESSION_COOKIE_NAME)
            )
            if user is not None:
                request.state.user = user
            return await call_next(request)
        if self._is_public(request):
            return await call_next(request)

        user = self._store.get_user_for_token(
            request.cookies.get(SESSION_COOKIE_NAME)
        )
        if user is None:
            if (
                request.method in {"GET", "HEAD"}
                and "text/html" in request.headers.get("accept", "")
                and request.url.path not in {"/", "/auth/login", "/auth/register"}
            ):
                return RedirectResponse("/", status_code=303)
            return JSONResponse(
                {"detail": "Sessão inválida ou expirada."},
                status_code=401,
            )
        request.state.user = user
        return await call_next(request)

    def _origin_is_allowed(self, request: Request) -> bool:
        if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
            return True
        origin = request.headers.get("origin")
        if origin is None or origin in self._allowed_origins:
            return True
        schemes = {request.url.scheme}
        forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0]
        if forwarded_proto.strip():
            schemes.add(forwarded_proto.strip())
        return any(
            origin == f"{scheme}://{request.url.netloc}" for scheme in schemes
        )

    @staticmethod
    def _is_cors_preflight(request: Request) -> bool:
        return (
            request.method == "OPTIONS"
            and bool(request.headers.get("Origin"))
            and bool(request.headers.get("Access-Control-Request-Method"))
        )

    @staticmethod
    def _is_public(request: Request) -> bool:
        path = request.url.path
        if path in _PUBLIC_AUTH_PATHS or path in _PUBLIC_HEALTH_PATHS:
            return True
        if request.method not in {"GET", "HEAD"}:
            return False
        if path.startswith("/assets/"):
            return True
        if path.startswith("/workbox-"):
            return True
        if path in _PUBLIC_STATIC_PATHS:
            return True
        static_dir = getattr(request.app.state, "frontend_static_dir", None)
        if static_dir:
            root = Path(static_dir).resolve()
            candidate = (root / path.lstrip("/")).resolve()
            if candidate.is_relative_to(root) and candidate.is_file():
                return True
        if path in _PROTECTED_NON_API_PATHS or path.startswith(
            ("/docs/", "/redoc/")
        ):
            return False
        if path == "/metrics" or path.startswith("/metrics/"):
            return False
        # The unauthenticated document serves only the login shell. Data APIs
        # and server-rendered pages remain protected by the default-deny path.
        return False


def authenticated_websocket_user(websocket) -> dict[str, str] | None:  # noqa: ANN001
    store = getattr(websocket.app.state, "auth_store", None)
    if store is None:
        return None
    return store.get_user_for_token(
        websocket.cookies.get(SESSION_COOKIE_NAME)
    )
