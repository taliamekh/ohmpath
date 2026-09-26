"""The two offline reasoning paths share explanation-only presentation guidance."""

from ohmpath.ai import photo_runtime, runtime
from ohmpath.ai.presentation import EXPLANATION_PRESENTATION


def test_both_restricted_paths_share_the_same_explanation_guidance():
    assert photo_runtime.EXPLANATION_PRESENTATION is EXPLANATION_PRESENTATION
    assert runtime.EXPLANATION_PRESENTATION is EXPLANATION_PRESENTATION


def test_guidance_keeps_personality_out_of_evidence_and_readback():
    text = EXPLANATION_PRESENTATION
    for required in (
        "only the user-facing explanation field",
        "calm, reserved, unhurried English",
        "understated dry aside",
        "never joke about safety, uncertainty, or a measurement",
        "Do not roleplay",
        "visible feature is an observation",
        "simulation is a prediction",
        "explicitly confirmed reading",
        "exact numbers and units",
        "measurement readback",
        "do not alter circuit reasoning or measurement acceptance",
    ):
        assert required in text
