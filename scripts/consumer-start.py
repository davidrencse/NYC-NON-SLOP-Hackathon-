"""Start local services with private credentials from --env-file; never prints values."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
from dotenv import dotenv_values

parser = argparse.ArgumentParser()
parser.add_argument('--env-file', required=True)
parser.add_argument('--hermes-source', required=True)
args = parser.parse_args()
values = dotenv_values(args.env_file)
env = dict(os.environ)
for name in ('ANTHROPIC_API_KEY', 'REDUCTO_API_KEY'):
    if values.get(name):
        env[name] = values[name]
if not env.get('REDUCTO_API_KEY') and values.get('REDUCTO'):
    env['REDUCTO_API_KEY'] = values['REDUCTO']
env['FORGE_HERMES_SOURCE'] = str(Path(args.hermes_source).resolve())
env['FORGE_HERMES_PYTHON'] = str(Path(args.hermes_source).resolve() / '.venv/bin/python')
children = []
try:
    children.append(subprocess.Popen(['uv', 'run', '--locked', '--python', '3.12', 'python', '-m', 'forge_research.studio'], env=env, start_new_session=True))
    children.append(subprocess.Popen(['npm', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], cwd='pcb-studio', env=env, start_new_session=True))
    for child in children:
        child.wait()
except KeyboardInterrupt:
    pass
finally:
    for child in children:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
