#!/usr/bin/env python3
"""EIGOS client using A2A 1.0 plus the documented application authorization channel. Python 3.10+, standard library only."""
import argparse
import ipaddress
import json
import os
import re
from pathlib import Path
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_RESPONSE = 8 * 1024 * 1024
DEFAULT_SERVICES = ['eigos.delegate']
TERMINAL = {'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'}


class ClientError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ClientError('Redirect refused; verify the configured address before retrying')


def address(value, allow_local=False):
    p = urllib.parse.urlsplit(value)
    if p.username or p.password or p.query or p.fragment or not p.hostname:
        raise ClientError('Address must not contain credentials, query or fragment')
    local = p.hostname == 'localhost'
    try:
        local = local or ipaddress.ip_address(p.hostname).is_loopback
    except ValueError:
        pass
    if p.scheme != 'https' and not (allow_local and p.scheme == 'http' and local):
        raise ClientError('HTTPS required; HTTP is allowed only for explicitly enabled loopback development')
    try:
        return (p.scheme, p.hostname.lower(), p.port or (443 if p.scheme == 'https' else 80))
    except ValueError:
        raise ClientError('Invalid address port') from None


def write_private(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.write('\n')
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        temporary.unlink(missing_ok=True)


class Client:
    def __init__(self, config_path):
        self.path = Path(config_path).expanduser().resolve()
        try:
            self.config = json.loads(self.path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            raise ClientError('Configuration missing or invalid; run configure first') from None
        self.origin = address(self.config['cardUrl'], self.config.get('allowLoopbackHttp', False))
        # Never follow redirects with a Bearer header, including same-host redirects.
        self.opener = urllib.request.build_opener(NoRedirect())

    def token(self):
        try:
            if self.config.get('tokenFile'):
                path = Path(self.config['tokenFile'])
                if os.name != 'nt' and path.stat().st_mode & 0o077:
                    raise ClientError('Token file must be readable only by its owner (chmod 600)')
                token = path.read_text(encoding='utf-8').strip()
            else:
                token = os.environ.get(self.config['tokenEnv'], '').strip()
        except OSError:
            raise ClientError('Credential file unavailable; restore it through the secure setup path') from None
        if not token or any(c.isspace() for c in token):
            raise ClientError('Credential unavailable or malformed; refresh the configured credential source')
        return token

    def request(self, url, body=None):
        if address(url, self.config.get('allowLoopbackHttp', False)) != self.origin:
            raise ClientError('Cross-origin endpoint refused; reconfigure explicitly before sharing credentials or task content')
        headers = {'Accept': 'application/json'}
        if body is not None:
            headers.update({'Content-Type': 'application/json', 'A2A-Version': '1.0', 'Authorization': 'Bearer ' + self.token()})
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
        request = urllib.request.Request(url, data=data, headers=headers)
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(MAX_RESPONSE + 1)
        except urllib.error.HTTPError as error:
            # Do not print response bodies, request headers or credentials.
            if error.code in (401, 403):
                raise ClientError('Authentication/permission denied; refresh credentials or obtain the required task scopes') from None
            raise ClientError(f'HTTP {error.code}; preserve the request ID and inspect task state before retrying') from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ClientError('Connection unavailable or timed out; preserve the request ID, then retry the same operation') from None
        if len(raw) > MAX_RESPONSE:
            raise ClientError('Response exceeded size limit')
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            raise ClientError('Server returned invalid JSON') from None

    def discover(self):
        card = self.request(self.config['cardUrl'])
        if not isinstance(card, dict) or not isinstance(card.get('skills'), list):
            raise ClientError('Invalid Agent Card')
        interface = next((i for i in card.get('supportedInterfaces', [])
                          if i.get('protocolBinding') == 'JSONRPC' and i.get('protocolVersion') == '1.0'), None)
        if not interface:
            raise ClientError('Card does not advertise the supported A2A 1.0 JSONRPC interface')
        endpoint = interface.get('url', '')
        if address(endpoint, self.config.get('allowLoopbackHttp', False)) != self.origin:
            raise ClientError('Card advertises a different origin; endpoint refused')
        return card, endpoint

    def rpc(self, method, params, endpoint=None):
        if endpoint is None:
            _, endpoint = self.discover()
        identifier = str(uuid.uuid4())
        response = self.request(endpoint, {'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params})
        if not isinstance(response, dict) or response.get('jsonrpc') != '2.0' or response.get('id') != identifier:
            raise ClientError('Invalid JSON-RPC response identity')
        if 'error' in response:
            code = response['error'].get('code') if isinstance(response['error'], dict) else None
            raise ClientError(f'A2A request rejected (code {code}); inspect inputs and task state. No automatic retry performed')
        result = response.get('result')
        task = result.get('task', result) if isinstance(result, dict) else None
        if not isinstance(task, dict) or not isinstance(task.get('id'), str) or not task.get('status', {}).get('state'):
            raise ClientError('Expected an A2A task response')
        return task

    def write(self, operation, request_id, params, endpoint):
        if not request_id or len(request_id) > 128:
            raise ClientError('Use a stable request ID of 1–128 characters for this operation')
        database = self.path.with_suffix('.requests.sqlite')
        fd = os.open(database, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(database, 0o600)
        # Store the operation before sending, so a network failure cannot lose its identity.
        # Config origin is part of the identity; reconfiguration cannot reuse another server's receipt.
        payload = json.dumps([self.config['cardUrl'], params], sort_keys=True, ensure_ascii=False)
        with sqlite3.connect(database, timeout=5) as db:
            db.execute('CREATE TABLE IF NOT EXISTS requests(operation TEXT, request_id TEXT, payload TEXT, PRIMARY KEY(operation,request_id))')
            db.execute('BEGIN IMMEDIATE')
            prior = db.execute('SELECT payload FROM requests WHERE operation=? AND request_id=?', (operation, request_id)).fetchone()
            if prior and prior[0] != payload:
                raise ClientError('Request ID already belongs to different content; use the original content or a new ID')
            db.execute('INSERT OR IGNORE INTO requests VALUES(?,?,?)', (operation, request_id, payload))
        return self.rpc('SendMessage', params, endpoint)

    def submit(self, data, request_id):
        if not isinstance(data, dict) or not isinstance(data.get('goal'), str) or not data['goal'].strip():
            raise ClientError('Input must contain an explicit service and a non-empty goal')
        service = data.get('service')
        if service not in self.config['allowedServices']:
            raise ClientError('Service is outside this connection\'s configured delegation allowlist')
        if any(k in data for k in ('requestId', 'taskId', 'contextId')):
            raise ClientError('Task and request identity are managed by the client; omit them from input')
        card, endpoint = self.discover()
        if not any(s.get('id') == service for s in card['skills']):
            raise ClientError('Requested service is not enabled in the current Agent Card')
        return self.write('submit', request_id, {'configuration': {'returnImmediately': True}, 'message': {
            'messageId': request_id, 'role': 'ROLE_USER', 'parts': [{'data': data}],
        }}, endpoint)

    def reply(self, task_id, data, request_id):
        if not isinstance(data, dict) or any(k in data for k in ('taskId', 'requestId', 'contextId', 'service')):
            raise ClientError('Reply must contain only answer or the service-specific confirmation fields')
        # Check task ownership/service before sending a continuation. Exact retries remain allowed.
        current = self.rpc('GetTask', {'id': task_id})
        if current.get('metadata', {}).get('service') not in self.config['allowedServices']:
            raise ClientError('Task service is outside the configured delegation allowlist')
        _, endpoint = self.discover()
        return self.write('reply:' + task_id, request_id, {'configuration': {'returnImmediately': True}, 'message': {
            'messageId': request_id, 'taskId': task_id, 'role': 'ROLE_USER', 'parts': [{'data': data}],
        }}, endpoint)

    def payment_result(self, task_id, data, request_id):
        allowed = {'handoffId', 'handoffDigest', 'outcome'}
        if not isinstance(data, dict) or set(data) != allowed or data.get('outcome') not in ('submitted', 'declined', 'unknown', 'canceled'):
            raise ClientError('Payment notification accepts only handoffId, handoffDigest and outcome; never include wallet credentials')
        if any(not isinstance(data.get(k), str) or len(data[k]) != 64 or any(c not in '0123456789abcdef' for c in data[k]) for k in ('handoffId', 'handoffDigest')):
            raise ClientError('Use the exact original payment handoff ID and digest')
        try:
            uuid.UUID(request_id)
        except (ValueError, TypeError, AttributeError):
            raise ClientError('Payment notifications require a stable UUID request ID') from None
        current = self.rpc('GetTask', {'id': task_id})
        if current.get('metadata', {}).get('service') not in self.config['allowedServices']:
            raise ClientError('Task service is outside the configured delegation allowlist')
        request = current.get('metadata', {}).get('delegation', {}).get('agent', {}).get('paPayment', {}).get('request', {})
        if request.get('id') != data['handoffId'] or request.get('digest') != data['handoffDigest']:
            raise ClientError('Payment notification does not match the owned task handoff')
        _, endpoint = self.discover()
        return self.write('payment-result:' + task_id, request_id, {'configuration': {'returnImmediately': True}, 'message': {
            'messageId': request_id, 'taskId': task_id, 'role': 'ROLE_USER',
            'parts': [{'data': {'action': 'report_payment_result', **data}}],
        }}, endpoint)

    def send_text(self, text, request_id, task_id=None):
        card, endpoint = self.discover()
        if task_id:
            current = self.rpc('GetTask', {'id': task_id}, endpoint)
            service = current.get('metadata', {}).get('service')
        else:
            service = self.config.get('defaultService', 'eigos.delegate')
        if service not in self.config['allowedServices'] or not any(s.get('id') == service for s in card['skills']):
            raise ClientError('Delegation service is not configured and enabled; no fallback performed')
        parts = [{'data': {'service': service, 'goal': text}}] if not task_id and self.config.get('defaultService') else [{'text': text}]
        message = {'messageId': request_id, 'role': 'ROLE_USER', 'parts': parts}
        if task_id:
            message['taskId'] = task_id
        return self.write('reply:' + task_id if task_id else 'submit', request_id,
                          {'configuration': {'returnImmediately': True}, 'message': message}, endpoint)

    def authorize(self, task_id, data):
        current = self.rpc('GetTask', {'id': task_id})
        if current.get('metadata', {}).get('service') not in self.config['allowedServices']:
            raise ClientError('Task service is outside the configured allowlist')
        if not isinstance(data, dict) or not isinstance(data.get('requestId'), str) or not 1 <= len(data['requestId']) <= 128:
            raise ClientError('Supply an exact sandbox confirmation with a stable requestId')
        if data.get('action') == 'approve_plan':
            required = {'requestId', 'action', 'planDigest', 'allowedEffects', 'maxAmount', 'payeeIds', 'expiresAt', 'environment'}
            amount, effects, payees = data.get('maxAmount'), data.get('allowedEffects'), data.get('payeeIds')
            if set(data) != required or data['environment'] != 'sandbox' or not isinstance(data['planDigest'], str) or not re.fullmatch(r'[a-f0-9]{64}', data['planDigest']):
                raise ClientError('Plan approval requires exact fields, a plan digest and environment sandbox')
            if not isinstance(effects, list) or not 1 <= len(effects) <= 8 or any(e not in ('local', 'read', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund') for e in effects):
                raise ClientError('Plan approval has invalid declared effects')
            if not isinstance(amount, dict) or set(amount) != {'minor', 'currency'} or not isinstance(amount['minor'], str) or not re.fullmatch(r'(0|[1-9][0-9]{0,17})', amount['minor']) or not isinstance(amount['currency'], str) or not re.fullmatch(r'[A-Z]{3}', amount['currency']):
                raise ClientError('Plan approval requires an explicit minor-unit amount and currency')
            if not isinstance(payees, list) or len(payees) > 8 or any(not isinstance(p, str) or not 1 <= len(p) <= 200 for p in payees) or not isinstance(data['expiresAt'], str) or not data['expiresAt']:
                raise ClientError('Plan approval requires exact payees and a finite expiry')
        elif data.get('action') != 'confirm_simulated_payment' or set(data) != {'requestId', 'action', 'quoteId', 'quoteDigest'}:
            raise ClientError('Supply the exact supported sandbox confirmation fields')
        if not task_id or any(c not in '0123456789abcdef-' for c in task_id.lower()):
            raise ClientError('Invalid task ID')
        base = urllib.parse.urlsplit(self.config['cardUrl'])
        url = urllib.parse.urlunsplit((base.scheme, base.netloc, '/tasks/' + task_id + '/authorize', '', ''))
        return self.request(url, data)

    def poll(self, task_id, seconds, interval):
        deadline = time.monotonic() + seconds
        _, endpoint = self.discover()
        while True:
            task = self.rpc('GetTask', {'id': task_id}, endpoint)
            state = task['status']['state']
            if state in TERMINAL or state in ('TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'):
                return {'task': task, 'resumeRequired': False}
            if state not in ('TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED'):
                raise ClientError('Unrecognized task state; inspect the task instead of guessing completion')
            if time.monotonic() >= deadline:
                return {'task': task, 'resumeRequired': True}
            time.sleep(min(interval, max(0, deadline - time.monotonic())))


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise ClientError('Input file unavailable or not valid JSON') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(Path.home() / '.config/eigos/grok.json'))
    commands = parser.add_subparsers(dest='command', required=True)
    configure = commands.add_parser('configure')
    configure.add_argument('--card-url', required=True)
    credentials = configure.add_mutually_exclusive_group(required=True)
    credentials.add_argument('--token-file')
    credentials.add_argument('--token-env')
    configure.add_argument('--allow-loopback-http', action='store_true')
    configure.add_argument('--allow-service', action='append')
    configure.add_argument('--default-service')
    commands.add_parser('discover')
    send = commands.add_parser('send')
    send.add_argument('--text-file', required=True)
    send.add_argument('--request-id', required=True)
    send.add_argument('--task-id')
    authorize = commands.add_parser('authorize')
    authorize.add_argument('--task-id', required=True)
    authorize.add_argument('--input-file', required=True)
    payment = commands.add_parser('payment-result')
    payment.add_argument('--task-id', required=True)
    payment.add_argument('--input-file', required=True)
    payment.add_argument('--request-id', required=True)
    submit = commands.add_parser('submit')
    submit.add_argument('--input-file', required=True)
    submit.add_argument('--request-id', required=True)
    reply = commands.add_parser('reply')
    reply.add_argument('--task-id', required=True)
    reply.add_argument('--input-file', required=True)
    reply.add_argument('--request-id', required=True)
    get = commands.add_parser('get')
    get.add_argument('--task-id', required=True)
    poll = commands.add_parser('poll')
    poll.add_argument('--task-id', required=True)
    poll.add_argument('--seconds', type=float, default=45)
    poll.add_argument('--interval', type=float, default=3)
    cancel = commands.add_parser('cancel')
    cancel.add_argument('--task-id', required=True)
    args = parser.parse_args()
    if args.command == 'configure':
        address(args.card_url, args.allow_loopback_http)
        config = {'cardUrl': args.card_url, 'allowedServices': args.allow_service or DEFAULT_SERVICES,
                  'allowLoopbackHttp': args.allow_loopback_http}
        if args.default_service:
            if args.default_service not in config['allowedServices']:
                raise ClientError('Default service must be in the configured delegation allowlist')
            config['defaultService'] = args.default_service
        if args.token_file:
            config['tokenFile'] = str(Path(args.token_file).expanduser().resolve())
        else:
            if not args.token_env or not args.token_env.replace('_', 'a').isalnum() or args.token_env[0].isdigit():
                raise ClientError('Use an environment variable name, not a credential value')
            config['tokenEnv'] = args.token_env
        # Discovery must succeed before replacing an existing working configuration.
        client = object.__new__(Client)
        client.config = config
        client.origin = address(config['cardUrl'], config['allowLoopbackHttp'])
        client.opener = urllib.request.build_opener(NoRedirect())
        card, _ = client.discover()
        if args.default_service and not any(s.get('id') == args.default_service for s in card['skills']):
            raise ClientError('Default service is not enabled in the current Agent Card')
        write_private(Path(args.config).expanduser().resolve(), config)
        output = {'configured': True, 'cardUrl': args.card_url, 'allowedServices': config['allowedServices']}
    else:
        client = Client(args.config)
        if args.command == 'discover':
            card, endpoint = client.discover()
            output = {'card': card, 'endpoint': endpoint, 'allowedServices': client.config['allowedServices']}
        elif args.command == 'send':
            try:
                text = Path(args.text_file).read_text(encoding='utf-8')
            except OSError:
                raise ClientError('Text input file unavailable') from None
            if not text.strip() or len(text) > 10000:
                raise ClientError('Text must contain 1–10000 characters')
            output = client.send_text(text, args.request_id, args.task_id)
        elif args.command == 'authorize':
            output = client.authorize(args.task_id, read_json(args.input_file))
        elif args.command == 'payment-result':
            output = client.payment_result(args.task_id, read_json(args.input_file), args.request_id)
        elif args.command == 'submit':
            output = client.submit(read_json(args.input_file), args.request_id)
        elif args.command == 'reply':
            output = client.reply(args.task_id, read_json(args.input_file), args.request_id)
        elif args.command == 'poll':
            if not 0 <= args.seconds <= 45 or not 0.1 <= args.interval <= 30:
                raise ClientError('Poll for at most 45 seconds with a 0.1–30 second interval; resume with the same task ID')
            output = client.poll(args.task_id, args.seconds, args.interval)
        elif args.command == 'cancel':
            output = client.rpc('CancelTask', {'id': args.task_id})
        else:
            output = client.rpc('GetTask', {'id': args.task_id})
    print(json.dumps(output, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ClientError, KeyError, TypeError, ValueError, sqlite3.Error) as error:
        message = str(error) if isinstance(error, ClientError) else 'Invalid configuration, protocol data or local request store; inspect setup'
        print(json.dumps({'error': message}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
