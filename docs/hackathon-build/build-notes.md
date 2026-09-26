# Build notes, decisions, and evidence

Baseline: September 26, 2026. These notes distinguish established inputs from work still to do.

## Current decisions

| Decision | Rationale and revisit condition |
| --- | --- |
| Ohm Path replaces Benchmate as product name | User request; retain historical files rather than breaking old references |
| Custom Windows application, local authoritative backend | Needed for circuit tools, live devices, own UI and desktop companion |
| Codex subscription adapter first, Astra where available | Reuses observed account access without default API billing; reconsider only after the permission/tool-loop gate or explicit user choice |
| No Jev or local reasoning-model dependency | They were suggestions, not requirements; stronger grounded reasoning is the priority |
| KiCad + ngspice + physical evidence | Simulation supports hypotheses; measurements discriminate real faults |
| Pi 5 + Camera Module 3 Wide + Ethernet | User's actual hardware and available direct cable replace old ESP32 control assumptions |
| iPhone through USB camera adapter | Avoid venue Wi-Fi peer isolation and custom phone-app work initially |
| Local two-axis crosshair feedback | User's aiming proposal; calibrated beam prediction and target tracking replace repeated cloud steering calls |
| Local dedicated transcription, ElevenLabs output | Two-way voice without a new transcription bill; output remains a separate service |
| Frieren first, three-slot guide registry | Presentation stays separate from circuit truth; remaining characters/assets unresolved |
| Regression fixtures, not a two-circuit ceiling | Validate the whole loop first, then broaden model/instrument support |

## Existing evidence and limits

- Earlier local inspection found a signed-in Codex CLI and a text/image `gpt-6-astra` model listing. Version recorded then: `0.155.0-alpha.16.4`. No complete Ohm Path model/tool turn has been verified. Recheck at the implementation gate rather than assuming continued availability.
- Existing installation notes record KiCad 10.0.6 and ngspice 47. A generic divider simulation returned 2.5 V, and KiCad sample exports succeeded. This is toolchain evidence only, not the project's integrated test suite.
- The supplied meter link corresponds to KAIWEETS HT118A. No documented digital data interface is relied upon; OCR, voice and typed entry are the planned input paths.
- Local hardware inspection previously recorded approximately 32 GB RAM and an RTX 5070 Laptop GPU. Local speech/vision performance and acceleration compatibility remain unmeasured.
- Current mechanical design inputs are the R10 MG996R base and R11 wide-camera arm. CAD checks are not physical fit, load, ribbon-clearance, accuracy or safety verification. The Pi camera moves with the laser.
- GitHub inspection found the supplied `taliamekh/ohmpath` repository accessible and empty at planning time. This workspace contained no commits or remote before repository setup in this turn. GitHub authentication and local commit-author metadata are separate concerns.

No account allowance percentage is frozen into this plan: development and runtime share changing limits. No credit reset, top-up or paid model request is authorized by this documentation task.

## Historical source map

These are local historical paths, not promised files in a fresh clone. They stay excluded from the initial repository until deliberately curated.

| Local source | Carry forward | Superseded or still unverified |
| --- | --- | --- |
| `outputs/Benchmate-Circuit-and-Probe-Guide.md` | Passive fixture concepts and probe reasoning | Not a universal scope restriction |
| `outputs/Benchmate-SPICE-KiCad-Integration.md` | Installed tool checks and bounded subprocess rationale | Old name and earlier feature priorities |
| `outputs/Benchmate-Hack-the-Hill-Project-Plan.md` | Historical context and useful questions | ESP32 architecture, old scope exclusions, old network approach; event details need current review |
| `outputs/turret/Physical-Fit-Feedback.md` | User's recorded fit observations | Not every later revision has been printed or checked |
| `outputs/turret/R10-MG996R-Base/READ-ME-MG996R-BASE.md` | Current adjustable base design | Actual variant dimensions/load/fit unverified |
| `outputs/turret/R11-Camera-Wide/READ-ME-CAMERA-AND-BASE.md` | Current camera arm, nominal 24 mm optical-axis offset | Flexible cable behavior and actual aim calibration unverified |

Do not bulk-rename or publish the old `outputs/` tree. Curate the current hardware source, BOM, source/license records and selected manufacturing exports into `hardware/` in a separate reviewed change. Keep large generated artifacts out of ordinary source history unless their storage policy is deliberate.

## Decisions still requiring evidence or the user

- Actual laser identification/class/power/driver, motor power/controller, physical held-enable/kill and independent timeout components: required before final wiring and emission.
- Printed/assembled status, actual pitch servo and camera cable: required before motor tests. CAD nominal dimensions are not measurements of the bench.
- Current iPhone, cable, Camo compatibility and camera placement: required before choosing the final capture profile.
- Actual MCU board, firmware project, power limits and appropriate measurement tools: required for the physical firmware diagnostic fixture.
- ElevenLabs account/voice/budget, microphone preference, and approved guide assets; other two character identities: required for final voice/presentation completion, not for building adapters.
- Remaining hackathon time, official rules and submission requirements: required before a schedule or eligibility claim, not a reason to invent dates or restart registration.

## This documentation turn

Created the integrated specification, product requirements, build checklist, shared contracts, three specialist designs, subagent assignments, verification plan and repository rules. Explicitly included spoken questions/results and the user's crosshair-driven yaw/pitch controller. Existing private/history files were preserved locally. Application implementation, live paid inference, installations, device flashing and physical actuation were not performed.

Future implementation updates belong here as concise evidence-linked entries. Do not change a planned gate to passed without the corresponding result.

Cross-document review added measurement setup hashes and single-use confirmations, connection/arming epochs and command payload binding, distinct MCP/user capabilities, separate video/control SSH connections, and an explicit separation between aiming alignment and hardware permission. These are design corrections, not implemented protections yet.
