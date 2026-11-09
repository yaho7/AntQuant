"""Alpaca's standard endpoints and validation for administrator-supplied URLs."""

from urllib.parse import urlsplit

ALPACA_PAPER_URL = "https://paper-api.alpaca.markets"
ALPACA_LIVE_URL = "https://api.alpaca.markets"


def validate_endpoint(value: str) -> str:
    endpoint = value.strip().rstrip("/")
    try:
        url = urlsplit(endpoint)
        if url.port == 0:
            raise ValueError()
    except ValueError:
        raise ValueError("Enter a valid HTTP or HTTPS endpoint URL.") from None
    if (
        url.scheme not in {"http", "https"}
        or not url.hostname
        or url.username is not None
        or url.query
        or url.fragment
        or any(ch.isspace() for ch in endpoint)
    ):
        raise ValueError("Enter a valid HTTP or HTTPS endpoint URL.")
    return endpoint


def is_paper_endpoint(endpoint: str) -> bool:
    return endpoint.lower() == ALPACA_PAPER_URL
