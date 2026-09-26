# Ohm Path

A live electronics bench assistant that sees the circuit, listens to the person, tests explanations against simulation and real measurements, and shows exactly where to look next.

**Status: build plan documented; application implementation has not started.** Existing mechanical designs and tool-installation checks are inputs, not proof of a working integrated product. Planning baseline: September 26, 2026.

Repository: [taliamekh/ohmpath](https://github.com/taliamekh/ohmpath).

## Start here

1. [Product requirements](docs/hackathon-build/prd.md) — what the complete product must do.
2. [Technical build plan](docs/hackathon-build/spec.md) — architecture, technology choices, costs, and file layout.
3. [Build checklist](docs/hackathon-build/checklist.md) — order of work and evidence required to finish each milestone.
4. [Subagent work plan](docs/development/subagent-work-plan.md) — task ownership, parallel work, and integration rules.
5. [Verification plan](docs/testing/verification-plan.md) — how we distinguish a convincing explanation from a tested result.

## Detailed design

- [Circuit diagnosis and assembly](docs/architecture/diagnostic-engine.md)
- [Cameras, Raspberry Pi, and physical pointing](docs/architecture/hardware-and-vision.md)
- [Two-way voice and animated guides](docs/architecture/voice-and-interaction.md)
- [Shared data and service contracts](docs/architecture/contracts.md)
- [Evidence, decisions, and unresolved prerequisites](docs/hackathon-build/build-notes.md)
- [Repository and readable commit rules](CONTRIBUTING.md)

## Chosen direction

Ohm Path runs as its own Windows desktop application. The laptop handles the interface, circuit model, KiCad imports, ngspice simulations, local speech recognition, evidence history, and camera processing. A Raspberry Pi 5 with Camera Module 3 Wide connects over Ethernet and controls the physical pointer. An iPhone supplies a separate USB camera view.

Cloud reasoning connects through the user's local, signed-in Codex installation, subject to account access and allowance. ElevenLabs supplies spoken responses separately. Neither cloud reasoning nor paid voice is described as unlimited or free. A model suggests and explains; Ohm Path validates evidence and controls what can actually happen.

The first companion is Frieren, with a character registry designed for three guides. Asset permission, voice selection, and the other two characters remain explicit decisions. A placeholder is not a finished character.

## Historical material

The project was previously called Benchmate. Existing `outputs/` files remain unchanged locally; the plans above supersede their software architecture and scope restrictions. They are not automatically published because that folder mixes private notes, generated files, and earlier event material. Approved mechanical sources and clean test fixtures will be curated into the organized project during implementation.

There are intentionally no install or run instructions yet: no executable Ohm Path application has been delivered in this planning step.
