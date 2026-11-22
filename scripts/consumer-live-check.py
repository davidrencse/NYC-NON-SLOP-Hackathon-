"""One bounded actual Hermes test; privately loads an explicitly selected env file."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from dotenv import dotenv_values

values = dotenv_values(sys.argv[1])
env = dict(os.environ)
for key in ('ANTHROPIC_API_KEY',):
    if values.get(key):
        env[key] = values[key]
env['FORGE_HERMES_SOURCE'] = os.environ.get('FORGE_HERMES_SOURCE', '/tmp/forge-hermes-agent')
env['HERMES_HOME'] = os.environ.get('HERMES_HOME', '/tmp/forge-hermes-home')
python = str(Path(env['FORGE_HERMES_SOURCE']) / '.venv/bin/python')
started = time.monotonic()
try:
    analysis = subprocess.check_output(['node', '--experimental-strip-types', '--input-type=module', '-e', "import {analyze} from './server/consumer-repair.ts'; console.log(JSON.stringify(analyze({description:'rover motor under $30, preserve appearance',component_id:'m2'})))"], cwd='pcb-studio', text=True)
    result = subprocess.run([python, 'scripts/consumer-hermes.py'], input=analysis, env=env, text=True, capture_output=True, timeout=45)
    if result.returncode:
        lines = [line for line in result.stderr.splitlines() if line.startswith(('TypeError:', 'ValueError:', 'ImportError:', 'Hermes '))]
        print(json.dumps({'status': 'failed', 'elapsed_ms': (time.monotonic()-started)*1000, 'error': '\n'.join(lines[-2:]).replace(env.get('ANTHROPIC_API_KEY', 'NO_KEY'), '[REDACTED]')[:700]}))
    else:
        data = json.loads(result.stdout)
        Path('/tmp/forge-hermes-evidence.json').write_text(json.dumps(data))
        print(json.dumps(data))
except subprocess.TimeoutExpired:
    print(json.dumps({'status': 'timeout', 'deadline_seconds': 45}))
