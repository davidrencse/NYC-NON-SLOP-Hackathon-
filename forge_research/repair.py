"""Bounded autonomous Gemini repair agent for failed formal constraints."""

from __future__ import annotations

import asyncio
import json
from contextlib import aclosing
from typing import Literal

from google.adk.agents import LlmAgent, RunConfig
from google.adk.models import BaseLlm, LlmCapabilities, LlmRequest, LlmResponse
from google.adk.runners import InMemoryRunner
from google.genai import types
from pydantic import BaseModel, Field

from .catalog import ResearchError
from .models import (
    DeviceSpecification,
    ObligationResult,
    Part,
    WiringSpec,
)


class RepairPatchProposal(BaseModel):
    """Scoped electrical/controller patch proposed to resolve formal constraint failures."""

    resolvable: bool
    controller_id: str | None = None
    supply_rail_mv: int | None = Field(default=None, ge=1000, le=12000)
    signal_pins: list[str] | None = None
    status_led_pin: str | None = None
    clear_status_led_pin: bool = False
    rationale: str


class OfflineRepairModel(BaseLlm):
    """Deterministic scripted ADK repair model for offline sample/test runs."""

    model: str = "offline-repair-fixture"

    @property
    def capabilities(self) -> LlmCapabilities:
        return LlmCapabilities(output_schema_and_tools=False)

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False):
        prompt_text = "\n".join(
            part.text
            for content in llm_request.contents
            for part in (content.parts or [])
            if part.text
        )
        payload = json.loads(prompt_text)
        failed_ids = {item["id"] for item in payload["failed_obligations"]}
        spec = payload["current_spec"]
        catalog = payload["catalog_snapshot"]
        req = spec["requirements"]

        # Choose controller supporting requested transport if needed
        ctrl_comp = next(c for c in spec["components"] if c["role"] == "controller")
        sens_comp = next(c for c in spec["components"] if c["role"] == "emg_sensor")
        target_ctrl_id = ctrl_comp["catalog_id"]
        if "wireless_transport_support" in failed_ids:
            for cid, part in catalog.items():
                if part["role"] != "controller":
                    continue
                trans = set(part.get("transports") or [])
                if req["transport"] in trans or (
                    req["transport"] == "wireless" and bool(trans & {"ble", "wifi"})
                ):
                    target_ctrl_id = cid
                    break

        ctrl = catalog[target_ctrl_id]
        sens = catalog[sens_comp["catalog_id"]]
        wiring = spec["wiring"]

        # Only unresolvable if sole failure is budget and no valid controller swap lowers it enough
        if failed_ids == {"core_parts_budget"}:
            proposal = RepairPatchProposal(
                resolvable=False,
                rationale=(
                    "No combination of sourced catalog parts satisfies the current USD budget cap "
                    "without altering user requirements or sensor count."
                ),
            )
        else:
            s_min, s_max = sens.get("supply_range_mv") or [0, 99999]
            adc_max = ctrl.get("adc_max_mv") or 5000
            valid_rails = [
                r
                for r in (ctrl.get("available_rails_mv") or [3300])
                if s_min <= r <= s_max and r <= adc_max
            ]
            new_rail = valid_rails[0] if valid_rails else wiring["supply_rail_mv"]

            wifi_active = req["transport"] == "wifi"
            restricted = set(ctrl.get("reserved_pins") or []) | set(
                ctrl.get("board_restricted_adc_pins") or []
            )
            if wifi_active:
                restricted |= set(ctrl.get("adc_wifi_conflict_pins") or [])
            usable_adc = [p for p in (ctrl.get("adc_pins") or []) if p not in restricted]
            needed = sens_comp["quantity"]
            new_sig_pins = usable_adc[:needed] if len(usable_adc) >= needed else wiring["signal_pins"]

            led = wiring.get("status_led_pin")
            clear_led = False
            new_led = led
            if led:
                bad_led = (
                    set(ctrl.get("reserved_pins") or [])
                    | set(ctrl.get("input_only_pins") or [])
                    | set(new_sig_pins)
                )
                if led not in (ctrl.get("digital_pins") or []) or led in bad_led:
                    usable_led = [
                        p for p in (ctrl.get("digital_pins") or []) if p not in bad_led
                    ]
                    if usable_led:
                        new_led = usable_led[0]
                    else:
                        new_led = None
                        clear_led = True

            proposal = RepairPatchProposal(
                resolvable=True,
                controller_id=target_ctrl_id if target_ctrl_id != ctrl_comp["catalog_id"] else None,
                supply_rail_mv=new_rail,
                signal_pins=new_sig_pins,
                status_led_pin=new_led,
                clear_status_led_pin=clear_led,
                rationale=(
                    f"Set sensor rail to {new_rail} mV on {ctrl['sku']} so ratiometric output "
                    f"stays within the {adc_max} mV ADC limit, and bound analog channel(s) to "
                    f"{', '.join(new_sig_pins)} avoiding reserved/conflicting pins."
                ),
            )

        usage = types.GenerateContentResponseUsageMetadata(
            prompt_token_count=0, candidates_token_count=0, total_token_count=0
        )
        yield LlmResponse(
            content=types.Content(
                role="model", parts=[types.Part(text=proposal.model_dump_json())]
            ),
            usage_metadata=usage,
        )


REPAIR_INSTRUCTION = (
    "You are FORGE's Principal Electrical Verification & Repair Engineer. "
    "You receive a DeviceSpecification, sourced catalog records, and formal Lean 4 constraint "
    "failures. Propose a minimal, safe RepairPatchProposal using ONLY parts and pins present in "
    "catalog_snapshot. Rules:\n"
    "1. Never invent part IDs, voltages, or pins outside catalog_snapshot.\n"
    "2. If sensor output scales with supply (0–VIN), supply_rail_mv MUST be <= controller adc_max_mv "
    "AND within sensor supply_range_mv, chosen from controller available_rails_mv.\n"
    "3. signal_pins length must equal the EMG sensor quantity; every signal pin must be in controller "
    "adc_pins, NOT in reserved_pins, NOT in board_restricted_adc_pins, and if transport == 'wifi' "
    "(note: BLE does NOT block ADC2 on ESP32, only Wi-Fi does), NOT in adc_wifi_conflict_pins.\n"
    "4. If status_led_pin is used, it must be in digital_pins, NOT in input_only_pins or reserved_pins, "
    "and distinct from all signal_pins.\n"
    "5. If wireless_transport_support failed, switch controller_id to a controller in catalog_snapshot "
    "that supports the requested transport and adjust pins/rail to match that controller.\n"
    "6. You cannot change user requirements (budget, transport, sensor quantity). If a failure "
    "(such as a strict budget cap lower than all valid catalog combinations) cannot be solved "
    "by valid part/wiring selection, set resolvable=false and explain clearly in rationale."
)


async def propose_repair_patch(
    spec: DeviceSpecification,
    failed_obligations: list[ObligationResult],
    catalog_snapshot: dict[str, Part],
    model: str | BaseLlm,
) -> RepairPatchProposal:
    context_payload = {
        "current_spec": spec.model_dump(mode="json"),
        "failed_obligations": [ob.model_dump(mode="json") for ob in failed_obligations],
        "catalog_snapshot": {
            pid: part.model_dump(mode="json") for pid, part in catalog_snapshot.items()
        },
    }
    agent = LlmAgent(
        name="engineering_repair",
        model=model,
        instruction=REPAIR_INSTRUCTION,
        output_schema=RepairPatchProposal,
        output_key="repair_patch",
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
    )
    async with asyncio.timeout(45), InMemoryRunner(node=agent) as runner:
        session = await runner.session_service.create_session(
            app_name=runner.app_name, user_id="forge"
        )
        stream = runner.run_async(
            user_id="forge",
            session_id=session.id,
            new_message=types.Content(
                role="user", parts=[types.Part(text=json.dumps(context_payload))]
            ),
            run_config=RunConfig(max_llm_calls=3),
        )
        async with aclosing(stream):
            async for event in stream:
                if event.error_code:
                    raise ResearchError(
                        event.error_message or "Repair agent returned a model error."
                    )
        loaded = await runner.session_service.get_session(
            app_name=runner.app_name, user_id="forge", session_id=session.id
        )
        if loaded is None or "repair_patch" not in loaded.state:
            raise ResearchError("Repair agent did not produce a structured patch.")
        raw = loaded.state["repair_patch"]
        if isinstance(raw, str):
            return RepairPatchProposal.model_validate_json(raw)
        return RepairPatchProposal.model_validate(raw)


def apply_repair_patch(
    spec: DeviceSpecification,
    patch: RepairPatchProposal,
    catalog_snapshot: dict[str, Part],
) -> DeviceSpecification:
    updated = spec.model_copy(deep=True)
    if patch.controller_id is not None:
        new_ctrl = catalog_snapshot.get(patch.controller_id)
        if new_ctrl is None or new_ctrl.role != "controller":
            raise ResearchError(
                f"Repair proposed unknown or non-controller part '{patch.controller_id}'."
            )
        for comp in updated.components:
            if comp.role == "controller" and comp.catalog_id != new_ctrl.id:
                comp.catalog_id = new_ctrl.id
                comp.selected_offer_id = None
        updated.parts_by_instance["board"] = new_ctrl

    new_rail = (
        patch.supply_rail_mv
        if patch.supply_rail_mv is not None
        else updated.wiring.supply_rail_mv
    )
    new_sigs = (
        patch.signal_pins if patch.signal_pins is not None else list(updated.wiring.signal_pins)
    )
    if patch.clear_status_led_pin:
        new_led = None
    elif patch.status_led_pin is not None:
        new_led = patch.status_led_pin.strip() or None
    else:
        new_led = updated.wiring.status_led_pin

    updated.wiring = WiringSpec(
        supply_rail_mv=new_rail,
        signal_pins=new_sigs,
        status_led_pin=new_led,
    )
    return updated


def choose_repair_model(
    mode: Literal["live", "sample"], configured_gemini_model: str | None
) -> tuple[str | BaseLlm, Literal["claude", "gemini", "offline_fixture"]]:
    if mode == "live":
        if not configured_gemini_model:
            raise ResearchError(
                "Live Gemini repair requires GEMINI_API_KEY and FORGE_GEMINI_MODEL."
            )
        return configured_gemini_model, "gemini"
    return OfflineRepairModel(), "offline_fixture"
