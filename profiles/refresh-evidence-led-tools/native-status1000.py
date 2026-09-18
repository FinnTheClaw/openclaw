"""Existing native live runner, campaign-only 24-hour queue allowance in both arms."""
import argparse
import concurrent.futures
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import uuid

ROOT = Path('/home/finnclaw/phase2-memory-comparison-20260909')
PACKAGE = Path('/workspace/phase2-checker-runtime')
INPUT = Path('/workspace/reports/phase2-memory-comparison-20260909')
SOURCE_CONFIG = Path('/home/finnclaw/compatibility-tools-20260909T1600Z/openclaw.json')
TRACE = '/workspace/reports/openclaw-wire-trace.mjs'
spec = importlib.util.spec_from_file_location('evidence_publisher', '/workspace/reports/openclaw-recovery-acceptance1000.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
publish = publisher.publish

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def memory_snapshot(workspace):
    names = ['AGENTS.md', 'USER.md', 'SOUL.md', 'MEMORY.md', 'IDENTITY.md']
    names += [str(p.relative_to(workspace)) for p in sorted((workspace/'memory').glob('**/*')) if p.is_file()]
    return {name: (workspace/name).read_text(errors='replace') for name in names if (workspace/name).is_file()}

def create_workspace(path, fixtures, arm):
    path.mkdir(parents=True, exist_ok=False)
    template = (INPUT/'baseline-AGENTS.md').read_text()
    if arm != 'baseline':
        template += '\n' + (INPUT/'guidance.md').read_text()
    (path/'AGENTS.md').write_text(template)
    (path/'IDENTITY.md').write_text('# Identity\nName: Finn\n')
    (path/'SOUL.md').write_text('# Style\nBe helpful, honest and concise.\n')
    (path/'USER.md').write_text('# User\n')
    (path/'memory').mkdir()
    for relative, text in fixtures.items():
        target = path/relative
        if not target.resolve().is_relative_to(path.resolve()):
            raise ValueError('Fixture path escapes workspace')
        if relative in ('AGENTS.md', 'SOUL.md', 'IDENTITY.md'):
            raise ValueError('Fixture must not replace common instructions')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)


def run_turn(folder, workspace, prompt, arm, identity, *, plugin_config=None):
    folder.mkdir(parents=True, exist_ok=False)
    state = folder/'state'
    state.mkdir()
    config = json.loads(SOURCE_CONFIG.read_text())
    config['agents']['defaults']['workspace'] = str(workspace)
    config['agents']['defaults']['model'] = {'primary': 'finn-coordinator/moira/brain'}
    config['agents']['defaults']['modelPolicy'] = {'allow': ['finn-coordinator/moira/brain']}
    config['plugins'] = {'enabled': False, 'slots': {'memory': 'none'}}
    config['channels'] = {}
    config['agents']['defaults']['heartbeat'] = {'every': '0m'}
    config['cron'] = {'enabled': False, 'triggers': {'enabled': False}}
    config['models']['providers']['finn-coordinator']['apiKey'] = '${FINN_COORDINATOR_API_KEY}'
    if arm == 'checker':
        config['plugins'] = json.loads((INPUT/'checker-plugin-config.json').read_text())
    if plugin_config is not None:
        config['plugins'] = plugin_config
    config_path = folder/'openclaw.json'
    config_path.write_text(json.dumps(config, indent=2)+'\n')
    message = folder/'prompt.txt'
    message.write_text(prompt)
    before = memory_snapshot(workspace)
    publish(folder, 'before.json', before)
    env = os.environ.copy()
    env.update(HOME='/home/finnclaw', OPENCLAW_STATE_DIR=str(state), OPENCLAW_CONFIG_PATH=str(config_path),
               NODE_EXTRA_CA_CERTS='/home/finnclaw/certs/coordinator-edge-ca.pem', OPENCLAW_SKIP_CRON='1',
               OPENCLAW_WIRE_TRACE_DIR=str(folder/'wire'), OPENCLAW_WIRE_TRACE_ENABLED_FILE='',
               OPENCLAW_WIRE_TRACE_PACKAGE_JSON=str(PACKAGE/'package.json'), NODE_OPTIONS='--import='+TRACE)
    env['FINN_COORDINATOR_API_KEY'] = Path('/home/finnclaw/private/coordinator/api-key').read_text().strip()
    command = ['node', str(PACKAGE/'openclaw.mjs'), 'agent', '--local', '--agent', 'main',
               '--session-key', 'agent:main:main', '--session-id', str(uuid.uuid4()),
               '--message-file', str(message), '--thinking', 'medium', '--json', '--timeout', '86400']
    start = time.monotonic()
    started = now()
    with (folder/'stdout.json').open('x') as out, (folder/'stderr.log').open('x') as err:
        try:
            result = subprocess.run(command, env=env, cwd=workspace, stdout=out, stderr=err, timeout=86460)
            exit_code = result.returncode
        except subprocess.TimeoutExpired:
            exit_code = 'runner_timeout'
    after = memory_snapshot(workspace)
    publish(folder, 'after.json', after)
    row = {'identity': identity, 'arm': arm, 'startedAt': started, 'finishedAt': now(),
           'elapsedMs': round(1000*(time.monotonic()-start)), 'exitCode': exit_code,
           'workspace': str(workspace), 'freshSession': True, 'callerRetries': 0,
           'changedFiles': [p for p in sorted(set(before)|set(after)) if before.get(p)!=after.get(p)],
           'semanticVerdict': 'pending_adjudication'}
    try:
        payload = json.loads((folder/'stdout.json').read_text())
        result = payload.get('result', payload)
        meta = result.get('meta', {})
        text = '\n'.join(p.get('text','') for p in result.get('payloads',[]) if isinstance(p,dict))
        row.update(visibleText=text, meta=meta, status=payload.get('status'), runId=payload.get('runId'))
        row['turnOutcome'] = 'visible' if text.strip() else 'no_visible_payload'
    except (ValueError, AttributeError, TypeError):
        row['turnOutcome'] = 'unparsed_cli_result'
    if exit_code != 0:
        row['turnOutcome'] = 'execution_failure'
    publish(folder, 'record.json', row)
    return row


