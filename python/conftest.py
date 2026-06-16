"""pytest plugin: the `cowork` fixture + the `cowork` marker (B1, opt-in lane)."""
import pytest

from cowork_harness import Cowork


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "cowork: opt-in lane — drives the cowork-harness (spawns node + Docker). "
        "Select with `-m cowork`; deselect in the fast loop with `-m 'not cowork'`.",
    )


@pytest.fixture
def cowork() -> Cowork:
    """A Cowork runner bound to the built CLI (COWORK_HARNESS_CLI or <repo>/dist/cli.js)."""
    return Cowork()
