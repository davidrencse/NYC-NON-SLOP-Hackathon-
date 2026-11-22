"""Start both services; fail closed if either exits. Never print credential values."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import time
from dotenv import dotenv_values


def wait_for_exit(children):
    while True:
        for name, child in children:
            code = child.poll()
            if code is not None:
                return name, code
        time.sleep(0.1)


def stop_children(children):
    for _, child in children:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for _, child in children:
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


def main():
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
    source = Path(args.hermes_source).resolve()
    env['FORGE_HERMES_SOURCE'] = str(source)
    env['FORGE_HERMES_PYTHON'] = str(source / '.venv/bin/python')
    children = []
    try:
        children.append(('Python backend', subprocess.Popen(['uv', 'run', '--locked', '--python', '3.12', 'python', '-m', 'forge_research.studio'], env=env, start_new_session=True)))
        children.append(('Vite frontend', subprocess.Popen(['npm', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], cwd='pcb-studio', env=env, start_new_session=True)))
        name, code = wait_for_exit(children)
        raise SystemExit(f'{name} exited unexpectedly (code {code}); stopping sibling service. Check preceding errors and port conflicts. Set FORGE_PORT and matching FORGE_RESEARCH_URL if :8000 is occupied; Vite requires free :5173.')
    except KeyboardInterrupt:
        pass
    finally:
        stop_children(children)


if __name__ == '__main__':
    main()
