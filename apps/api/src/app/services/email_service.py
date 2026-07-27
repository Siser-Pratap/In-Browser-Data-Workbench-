"""Outbound email.

No provider is wired in Phase 1 — the default implementation logs the message
(and the verification/reset link) so flows are exercisable end-to-end in dev and
tests. Swap in an SMTP/SES/Resend implementation behind this interface later.
"""

import logging

logger = logging.getLogger("app.email")


class EmailService:
    def __init__(self, frontend_base_url: str) -> None:
        self.frontend_base_url = frontend_base_url
        # Tests inspect this instead of a real inbox.
        self.sent: list[dict] = []

    def _send(self, to: str, subject: str, body: str) -> None:
        self.sent.append({"to": to, "subject": subject, "body": body})
        logger.info("email.send", extra={"to": to, "subject": subject})

    def send_verification(self, to: str, token: str) -> None:
        link = f"{self.frontend_base_url}/verify-email?token={token}"
        self._send(to, "Verify your email", f"Confirm your account: {link}")

    def send_password_reset(self, to: str, token: str) -> None:
        link = f"{self.frontend_base_url}/reset-password?token={token}"
        self._send(to, "Reset your password", f"Reset your password: {link}")
