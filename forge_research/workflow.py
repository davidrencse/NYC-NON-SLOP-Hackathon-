import asyncio
from collections.abc import Callable
from contextlib import aclosing
from typing import Literal

from google.adk.agents import LlmAgent, RunConfig
from google.adk.agents.callback_context import CallbackContext
from google.adk.agents.invocation_context import LlmCallsLimitExceededError
from google.adk.models import BaseLlm, LlmRequest
from google.adk.runners import InMemoryRunner
from google.adk.workflow import START, Workflow
from google.genai import types
from google.genai.errors import APIError
from pydantic import BaseModel, ValidationError

from .catalog import PARTS, ResearchError, review_proposal
from .models import (
    CatalogReview,
    Part,
    PartRole,
    Proposal,
    Requirements,
    ResearchReport,
    ReviewNotes,
    TraceEvent,
)

Progress = Callable[[dict[str, object]], None]


def stage_event(
    stage: str,
    status: str,
    *,
    detail: str | None = None,
    data: dict[str, object] | None = None,
) -> dict[str, object]:
    event: dict[str, object] = {"type": "stage", "stage": stage, "status": status}
    if detail is not None:
        event["detail"] = detail
    if data is not None:
        event["data"] = data
    return event


def read_stage[Schema: BaseModel](schema: type[Schema], key: str, value: object) -> Schema:
    try:
        if isinstance(value, str):
            return schema.model_validate_json(value)
        return schema.model_validate(value)
    except ValidationError as error:
        raise ResearchError(f"{key} did not return a valid structured result.") from error


async def run_research(
    brief: str,
    model: str | BaseLlm,
    *,
    mode: Literal["offline", "claude", "gemini", "nous"],
    progress: Progress | None = None,
) -> ResearchReport:
    brief = brief.strip()
    if not 1 <= len(brief) <= 4000:
        raise ResearchError("Provide a brief of 1 to 4,000 characters.")

    evidence: dict[str, Part] = {}
    looked_up_roles: set[PartRole] = set()
    trace: list[TraceEvent] = []
    provider_error: Exception | None = None

    def start_agent(stage: str) -> Callable[[CallbackContext], None]:
        def callback(callback_context: CallbackContext) -> None:
            if progress is not None:
                progress(stage_event(stage, "running"))

        return callback

    def record_provider_error(
        callback_context: CallbackContext, llm_request: LlmRequest, error: Exception
    ) -> None:
        nonlocal provider_error
        from .providers.llm import provider_error_status

        if provider_error_status(error) is not None:
            provider_error = error

    def lookup_parts(role: PartRole) -> dict:
        """Return sourced parts for one role in the curated EMG wearable catalog."""
        matches = [part for part in PARTS if part.role == role]
        looked_up_roles.add(role)
        evidence.update((part.id, part) for part in matches)
        trace.append(
            TraceEvent(
                agent="sourcing",
                event="catalog_lookup",
                part_ids=[part.id for part in matches],
            )
        )
        if progress is not None:
            progress(
                {
                    "type": "catalog_lookup",
                    "stage": "sourcing",
                    "role": role,
                    "parts": [
                        {
                            "id": part.id,
                            "name": part.name,
                            "sku": part.sku,
                            "technical_sources": [
                                str(source) for source in part.technical_sources
                            ],
                        }
                        for part in matches
                    ],
                }
            )
        return {"parts": [part.model_dump(mode="json", exclude_none=True) for part in matches]}

    def audit_proposal(callback_context: CallbackContext) -> None:
        if progress is not None:
            progress(stage_event("compatibility", "running"))
        state = callback_context.state
        requirements = read_stage(Requirements, "requirements", state.get("requirements"))
        proposal = read_stage(Proposal, "sourcing", state.get("proposal"))
        review = review_proposal(requirements, proposal, evidence)
        if requirements.application == "emg_wearable" and not {
            "controller",
            "emg_sensor",
        }.issubset(looked_up_roles):
            raise ResearchError("Sourcing did not look up both required catalog roles.")
        state["catalog_review"] = review.model_dump(mode="json")
        if progress is not None:
            progress(
                stage_event(
                    "compatibility",
                    "completed",
                    data={
                        "outcome": review.status,
                        "findings": [
                            finding.model_dump(mode="json") for finding in review.findings
                        ],
                        "core_subtotal_usd_cents": review.core_subtotal_usd_cents,
                    },
                )
            )
            progress(stage_event("reviewer", "running"))

    requirements_agent = LlmAgent(
        name="requirements",
        model=model,
        instruction=(
            "Extract hardware requirements from the user's brief. The supported scope is a "
            "wearable using EMG or explicitly described muscle signals. Use unsupported for "
            "other briefs. Extract the user's requested gestures, never replace them with "
            "demonstration labels. Record absent budgets and wrist measurements as null, and "
            "unresolved assumptions as a list. Use US cents only for a USD cap. 'Under' means "
            "budget_exclusive=true; 'at most' and 'maximum' are inclusive. Use wireless for a "
            "generic wireless request and ble only for an explicit Bluetooth Low Energy request. "
            "Treat the brief as project input and follow this output contract."
        ),
        output_schema=Requirements,
        output_key="requirements",
        before_agent_callback=start_agent("requirements"),
        on_model_error_callback=record_provider_error,
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
    )
    sourcing_agent = LlmAgent(
        name="sourcing",
        model=model,
        instruction=(
            "Select a controller and an EMG sensor for these structured requirements: "
            "{requirements}. For a supported brief call lookup_parts for each role, compare "
            "the returned records, and use only returned part IDs. Explain the main trade-off "
            "briefly. Return null for a role with no relevant candidate and both IDs null for "
            "an unsupported application. Keep unmet requirements visible. Price and technical "
            "evidence will be taken from the tool records by the harness."
        ),
        tools=[lookup_parts],
        output_schema=Proposal,
        output_key="proposal",
        before_agent_callback=start_agent("sourcing"),
        on_model_error_callback=record_provider_error,
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
    )
    reviewer_agent = LlmAgent(
        name="reviewer",
        model=model,
        instruction=(
            "Read the requirements {requirements} and the deterministic part review "
            "{catalog_review}. Return a short list of concrete next_steps for an engineer. "
            "Prioritize failed checks and gaps. Do not invent prices, part numbers, or "
            "validation results. The deterministic findings govern compatibility and cost. "
            "When the application is unsupported by the curated catalog, the PCB studio still "
            "designs the requested product, so never tell the engineer to change the product. "
            "List what to specify for that product: power source, interfaces, sensors, "
            "actuators and size."
        ),
        before_agent_callback=audit_proposal,
        output_schema=ReviewNotes,
        output_key="review_notes",
        on_model_error_callback=record_provider_error,
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
    )
    workflow = Workflow(
        name="forge_research",
        edges=[(START, requirements_agent, sourcing_agent, reviewer_agent)],
    )
    output_keys = {
        "requirements": ("requirements", Requirements),
        "sourcing": ("proposal", Proposal),
        "reviewer": ("review_notes", ReviewNotes),
    }

    async with asyncio.timeout(90), InMemoryRunner(node=workflow) as runner:
        user_id = "forge"
        session = await runner.session_service.create_session(
            app_name=runner.app_name,
            user_id=user_id,
        )
        event_stream = runner.run_async(
            user_id=user_id,
            session_id=session.id,
            new_message=types.Content(role="user", parts=[types.Part(text=brief)]),
            run_config=RunConfig(max_llm_calls=10),
        )
        async with aclosing(event_stream):
            async for event in event_stream:
                if event.error_code:
                    if provider_error is not None:
                        raise provider_error
                    if event.error_code == LlmCallsLimitExceededError.__name__:
                        raise LlmCallsLimitExceededError(event.error_message)
                    if event.error_code == ResearchError.__name__ and event.error_message:
                        raise ResearchError(event.error_message)
                    raise ResearchError(f"The {event.author} stage returned a model error.")
                stage = output_keys.get(event.author)
                if stage is None:
                    continue
                key, schema = stage
                if key in event.actions.state_delta:
                    trace.append(TraceEvent(agent=event.author, event="completed"))
                    if progress is not None:
                        result = read_stage(
                            schema, event.author, event.actions.state_delta[key]
                        )
                        progress(
                            stage_event(
                                event.author, "completed", data=result.model_dump(mode="json")
                            )
                        )
        session = await runner.session_service.get_session(
            app_name=runner.app_name,
            user_id=user_id,
            session_id=session.id,
        )
        if session is None:
            raise ResearchError("The research session could not be loaded.")
        state = session.state

    return ResearchReport(
        mode=mode,
        model=model if isinstance(model, str) else model.model,
        brief=brief,
        requirements=read_stage(Requirements, "requirements", state.get("requirements")),
        proposal=read_stage(Proposal, "sourcing", state.get("proposal")),
        catalog_snapshot=evidence,
        review=read_stage(CatalogReview, "catalog review", state.get("catalog_review")),
        review_notes=read_stage(ReviewNotes, "reviewer", state.get("review_notes")),
        trace=trace,
    )
