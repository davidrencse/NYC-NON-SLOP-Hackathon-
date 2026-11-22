import argparse
import asyncio
import os
import sys

from google.adk.agents.invocation_context import LlmCallsLimitExceededError

from .catalog import ResearchError
from .offline import DEMO_BRIEF, DemoModel
from .workflow import run_research


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the FORGE component research swarm.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--offline", action="store_true", help="Run the scripted wristband fixture."
    )
    source.add_argument("--brief", help="Send a device brief to the live Claude workflow.")
    args = parser.parse_args()

    if args.offline:
        brief, model, mode = DEMO_BRIEF, DemoModel(), "offline"
    else:
        from .providers.llm import live_model

        live = live_model()
        if live is None:
            parser.error("Set ANTHROPIC_API_KEY for live Claude runs.")
        brief, model, mode = args.brief, live.adk_model(), live.mode

    try:
        report = asyncio.run(run_research(brief, model, mode=mode))
    except ResearchError as error:
        print(f"FORGE research failed. {error}", file=sys.stderr)
        return 1
    except Exception as error:
        from .providers.llm import provider_error_status

        status = provider_error_status(error)
        if status is None:
            raise
        print(f"Model provider request failed (API status {status}).", file=sys.stderr)
        return 1
    except (TimeoutError, LlmCallsLimitExceededError):
        print(
            "FORGE research exceeded its workflow time or model call limit.", file=sys.stderr
        )
        return 1
    print(report.model_dump_json(indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
