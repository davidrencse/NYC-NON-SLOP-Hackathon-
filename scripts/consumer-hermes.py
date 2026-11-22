"""Actual Hermes runtime worker. Read-only FORGE tools; no terminal or purchases."""
import contextlib
import json
import os
import sys
import time
import tempfile
import atexit
from pathlib import Path

home = tempfile.TemporaryDirectory(prefix='forge-hermes-')
atexit.register(home.cleanup)
os.environ['HERMES_HOME'] = home.name
Path(home.name, 'config.yaml').write_text("tools:\n  tool_search:\n    enabled: 'off'\nagent:\n  max_turns: 3\n")

sys.path.insert(0, os.environ['FORGE_HERMES_SOURCE'])
started = time.monotonic()
analysis = json.load(sys.stdin)
events = []
with contextlib.redirect_stdout(sys.stderr):
    from run_agent import AIAgent
    from tools.registry import registry

    def engineering(args, **kwargs):
        target = args.get('candidate_id')
        candidates = analysis['candidates']
        if target:
            candidates = [c for c in candidates if c['candidate_id'] == target]
        events.append({'tool': 'forge_engineering', 'candidate_id': target, 'result_count': len(candidates)})
        return json.dumps({'revision': analysis.get('design_revision', 0), 'goals': analysis['goals'],
                           'candidates': candidates, 'unresolved': analysis['unresolved'],
                           'status': analysis['status']})

    registry.register(name='forge_engineering', toolset='forge', schema={
        'name': 'forge_engineering', 'description': 'Retrieve deterministic FORGE catalog checks, known costs and provenance. Read-only, no physical approval.',
        'parameters': {'type': 'object', 'properties': {'candidate_id': {'type': 'string'}}}},
        handler=engineering, check_fn=lambda: True)
    from toolsets import create_custom_toolset
    create_custom_toolset('forge', description='Read-only FORGE engineering', tools=['forge_engineering'])
    agent = AIAgent(provider='anthropic', api_mode='anthropic_messages',
        api_key=os.environ['ANTHROPIC_API_KEY'], base_url='https://api.anthropic.com',
        model='claude-haiku-5-5', max_iterations=3, max_tokens=900, run_budget_seconds=35,
        enabled_toolsets=['forge'], fallback_model=None, skip_context_files=True,
        skip_memory=True, skip_background_review=True, quiet_mode=True,
        save_trajectories=False, checkpoints_enabled=False,
        ephemeral_system_prompt='You are FORGE repair advisor. Call forge_engineering to compare catalog options. Never override validators. No physical repair or purchase approval. Return ONLY JSON {"recommendation":null,"explanation":string,"missing_info":string[]}. Distinguish reported motor failure from diagnosis. All design previews are unverified.')
    result = agent.run_conversation('Compare replacement strategies for this reported problem and priorities: ' + json.dumps(analysis['goals']))

try:
    text = (result.get('final_response') or '').strip()
    if text.startswith('```') and text.endswith('```'):
        text = '\n'.join(text.splitlines()[1:-1])
    advice = json.loads(text)
except (ValueError, TypeError):
    raise SystemExit('Hermes output was not valid JSON; no fallback. ' + str(result.get('error') or result.get('final_response') or '')[:600].replace(os.environ['ANTHROPIC_API_KEY'], '[REDACTED]'))
if not isinstance(advice, dict) or advice.get('recommendation') is not None or not isinstance(advice.get('explanation'), str) or not isinstance(advice.get('missing_info'), list) or not all(isinstance(v, str) for v in advice['missing_info']):
    raise SystemExit('Hermes structured response rejected')
if not events:
    diagnostic = str(result.get('error') or result.get('final_response') or 'empty response')
    diagnostic = diagnostic.replace(os.environ['ANTHROPIC_API_KEY'], '[REDACTED]')
    raise SystemExit('Hermes did not call FORGE engineering tool: ' + diagnostic[:500])
print(json.dumps({'advice': advice, 'execution': {'runtime': 'NousResearch/hermes-agent',
    'model': 'claude-haiku-5-5', 'provider': 'anthropic', 'max_iterations': 3,
    'max_tokens': 900, 'elapsed_ms': (time.monotonic()-started)*1000, 'tools': events}}))
