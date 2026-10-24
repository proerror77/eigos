#!/usr/bin/env python3
"""PA-owned isolated payment executor. Supports only the local contract simulator.

The user's PA runs this helper with its own private test profile. EIGOS receives
no card or account credential. A durable dispatch record is written before the
POST; every subsequent invocation queries that original operation instead.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.dont_write_bytecode = True
from eigos_a2a import Client, ClientError, NoRedirect

PROTOCOL = 'eigos.shopify.pa-checkout.sandbox.v1'
ROUTES = ('pa_vault', 'pa_payment_account')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def instant(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.timestamp()
    except (ValueError, TypeError, AttributeError):
        raise ClientError('Invalid payment authorization timestamp') from None


def private_file(value, parse_json=True):
    path = Path(value)
    if not path.is_absolute():
        raise ClientError('Use absolute private test profile paths')
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid() or info.st_size > 65536:
            raise ClientError('Test credential/profile must be an owner-only regular file')
        value = path.read_text(encoding='utf-8')
        return json.loads(value) if parse_json else value.strip()
    except (OSError, ValueError):
        raise ClientError('Private test profile or credential is unavailable') from None


class TestPayment:
    def __init__(self, path):
        self.profile_path = str(Path(path).expanduser().resolve())
        self.config = private_file(self.profile_path)
        cfg = self.config
        if cfg.get('version') != 1 or cfg.get('environment') != 'sandbox' or cfg.get('realPayments') is not False:
            raise ClientError('Only an explicit isolated-test payment profile is supported')
        parsed = urllib.parse.urlsplit(cfg.get('endpoint', ''))
        if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.path not in ('', '/')
                or parsed.query or parsed.fragment or parsed.username or parsed.password):
            raise ClientError('The test payment executor only accepts a pinned 127.0.0.1 origin')
        self.endpoint = f'http://127.0.0.1:{parsed.port}'
        self.client = Client(cfg['a2aConfig'])
        if self.client.origin[0] != 'http' or self.client.origin[1] != '127.0.0.1':
            raise ClientError('The test payment task must belong to the isolated loopback EIGOS instance')
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        database = Path(cfg['databasePath'])
        if not database.is_absolute() or database.is_symlink():
            raise ClientError('The PA operation ledger must be an absolute private local file')
        database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if database.exists() and (database.stat().st_mode & 0o077 or database.stat().st_uid != os.getuid()):
            raise ClientError('The PA operation ledger must be owned privately by the PA user')
        self.db = sqlite3.connect(str(database), timeout=10)
        os.chmod(database, 0o600)
        self.db.execute('CREATE TABLE IF NOT EXISTS payments (handoff TEXT PRIMARY KEY,task TEXT UNIQUE,operation TEXT UNIQUE,request_digest TEXT,selection_digest TEXT,route TEXT,minor TEXT,currency TEXT,state TEXT,result TEXT)')
        self.db.commit()

    def source(self, path, body=None, authenticated=False):
        if not path.startswith('/') or path.startswith('//'):
            raise ClientError('Invalid isolated provider path')
        headers = {'Accept': 'application/json'}
        if authenticated:
            token = private_file(self.config['tokenFile'], False)
            if len(token) != 64 or any(char not in '0123456789abcdef' for char in token):
                raise ClientError('Invalid isolated PA credential; live credentials are not accepted')
            headers['Authorization'] = 'Bearer ' + token
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body, ensure_ascii=False).encode()
        try:
            with self.opener.open(urllib.request.Request(self.endpoint + path, data=data, headers=headers), timeout=20) as response:
                raw = response.read(131073)
            if len(raw) > 131072:
                raise ClientError('Test provider response exceeded its bound')
            return json.loads(raw)
        except urllib.error.HTTPError as error:
            if error.code == 404 and body is None:
                return {'state': 'not_found'}
            raise ClientError(f'Test provider rejected the operation (HTTP {error.code}); query the original operation') from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise ClientError('Test payment result is unknown; query the saved original operation') from None

    def current(self, task_id):
        current = self.client.rpc('GetTask', {'id': str(uuid.UUID(task_id))})
        handoff_state = current.get('metadata', {}).get('delegation', {}).get('agent', {}).get('paPayment', {})
        request = handoff_state.get('request', {})
        body = {key: value for key, value in request.items() if key != 'digest'}
        terms = request.get('terms', {})
        if (request.get('version') != '3' or request.get('taskId') != task_id or digest(body) != request.get('digest')
                or terms.get('environment') != 'sandbox' or terms.get('evidenceLevel') != 'synthetic'
                or terms.get('resource', {}).get('type') != 'shopify_checkout' or terms.get('checkout', {}).get('testMode') is not True
                or terms.get('routePolicy') != 'pa_selects_authorized_capability'):
            raise ClientError('Expected the exact owned version-3 isolated checkout handoff')
        if terms['checkout'].get('id') != terms['resource'].get('id'):
            raise ClientError('Payment handoff changed its original checkout')
        expected_url = self.endpoint + '/checkout/' + urllib.parse.quote(terms['resource']['id'], safe='')
        if terms['checkout'].get('url') != expected_url:
            raise ClientError('Checkout URL is outside the configured original test source')
        routes = terms.get('routes', [])
        if not routes or any(route.get('id') not in ROUTES or route.get('type') != 'sandbox.pa-checkout' or route.get('endpoint') != self.endpoint + '/pa/payments' for route in routes):
            raise ClientError('Payment handler is not the configured isolated simulator')
        return current, handoff_state, request

    def check_authorization(self, terms):
        if digest(private_file(self.profile_path)) != digest(self.config):
            raise ClientError('PA authorization changed; no new dispatch is allowed')
        authorization = self.config.get('authorization', {})
        amount = terms.get('amount', {})
        if (authorization.get('kind') != 'isolated_test_only' or authorization.get('payeeId') != terms.get('payeeId')
                or authorization.get('currency') != amount.get('currency') or not str(amount.get('minor', '')).isdigit()
                or int(amount['minor']) <= 0 or int(amount['minor']) > int(authorization.get('maximumMinor', '0'))
                or instant(authorization.get('expiresAt')) <= datetime.now(timezone.utc).timestamp()):
            raise ClientError('The PA own test authorization does not cover this payee, currency, amount or time')

    def authorized(self, terms):
        self.check_authorization(terms)
        health = self.source('/health')
        if (health.get('protocol') != PROTOCOL or health.get('environment') != 'sandbox' or health.get('evidenceLevel') != 'synthetic'
                or health.get('realPayments') is not False or health.get('providerId') != terms.get('providerId')
                or health.get('merchant', {}).get('id') != terms.get('payeeId')):
            raise ClientError('Provider did not prove the configured isolated test environment')

    def instrument(self, route):
        if route == 'pa_vault':
            vault = private_file(self.config['vaultFile'])
            expected = {'type': 'test_card', 'number': '4242424242424242', 'expiry': '12/30', 'cvc': '123'}
            if vault.get('environment') != 'sandbox' or vault.get('instrument') != expected:
                raise ClientError('The test Vault must contain only the documented synthetic card')
            return expected
        if route != 'pa_payment_account' or self.config.get('accountId') != 'pa-test-account':
            raise ClientError('An isolated PA test account is required')
        return {'type': 'test_account', 'id': 'pa-test-account'}

    def capabilities(self, task_id):
        _, _, request = self.current(task_id)
        self.authorized(request['terms'])
        capabilities = []
        for route in request['terms']['routes']:
            if route.get('supported') and route['id'] in self.config.get('allowedRoutes', []):
                self.instrument(route['id'])
                capabilities.append({'route': route['id'], 'status': 'available', 'environment': 'sandbox', 'observedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')})
        return {'handoffId': request['id'], 'handoffDigest': request['digest'], 'capabilities': capabilities, 'credentialsExposed': False}

    def query(self, task_id):
        _, _, request = self.current(task_id)
        row = self.db.execute('SELECT operation,request_digest,selection_digest,route FROM payments WHERE handoff=? AND task=?', (request['id'], task_id)).fetchone()
        if not row or row[1] != request['digest']:
            raise ClientError('No original PA dispatch exists for this handoff; never guess an operation')
        result = self.source('/pa/payments/' + row[0], authenticated=True)
        safe = self.safe_result(request, row[0], row[3], result)
        self.db.execute('UPDATE payments SET state=?,result=? WHERE handoff=?', (safe['state'], json.dumps(safe), request['id'])); self.db.commit()
        return {**safe, 'recoveredByQuery': True}

    @staticmethod
    def safe_result(request, operation, route, result):
        if result.get('state') != 'not_found' and (result.get('environment') != 'sandbox' or result.get('realPayment') is not False
                or result.get('operationId') != operation or result.get('checkoutId') != request['terms']['resource']['id']):
            raise ClientError('Payment response did not bind the original test checkout and operation')
        state = result.get('state', 'unknown')
        if state not in ('paid', 'processing', 'failed', 'unknown', 'not_found'):
            raise ClientError('Unrecognized test payment state; query the original operation')
        return {'environment': 'sandbox', 'realPayment': False, 'handoffId': request['id'], 'handoffDigest': request['digest'],
                'checkoutId': request['terms']['resource']['id'], 'operationId': operation, 'route': route, 'state': state,
                'outcome': 'submitted' if state in ('paid', 'processing') else 'declined' if state == 'failed' else 'unknown'}

    def pay(self, task_id):
        current, state, request = self.current(task_id)
        if self.db.execute('SELECT 1 FROM payments WHERE handoff=?', (request['id'],)).fetchone():
            return self.query(task_id)
        selection = state.get('selection', {})
        selected_body = {key: value for key, value in selection.items() if key != 'digest'}
        route = selection.get('route')
        if (digest(selected_body) != selection.get('digest') or selection.get('handoffDigest') != request['digest']
                or route not in self.config.get('allowedRoutes', []) or route not in ROUTES
                or selection.get('capability', {}).get('route') != route or selection.get('capability', {}).get('environment') != 'sandbox'):
            raise ClientError('Select and persist the PA own authorized test capability before paying')
        operation = str(uuid.UUID(selection['operationId']))
        self.authorized(request['terms']); instrument = self.instrument(route)
        if instant(request['terms']['expiresAt']) <= datetime.now(timezone.utc).timestamp():
            raise ClientError('Original checkout expired; no payment dispatched')
        # Re-read after readiness work and immediately before persisting dispatch.
        fresh, fresh_state, fresh_request = self.current(task_id)
        if (fresh.get('status', {}).get('state') != 'TASK_STATE_INPUT_REQUIRED'
                or fresh.get('metadata', {}).get('delegation', {}).get('phase') != 'awaiting_pa_payment'
                or fresh_state.get('status') != 'awaiting_pa' or fresh_request['digest'] != request['digest']
                or fresh_state.get('selection') != selection):
            raise ClientError('The original EIGOS task is no longer waiting for this payment')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            count = self.db.execute('SELECT count(*) FROM payments').fetchone()[0]
            if count >= self.config['authorization'].get('maximumPayments', 0):
                raise ClientError('PA test authorization payment count is exhausted')
            self.db.execute('INSERT INTO payments VALUES(?,?,?,?,?,?,?,?,?,NULL)', (request['id'], task_id, operation, request['digest'], selection['digest'], route, request['terms']['amount']['minor'], request['terms']['amount']['currency'], 'dispatching'))
            self.db.commit()
        except Exception:
            self.db.rollback(); raise
        try:
            self.check_authorization(request['terms'])
            if instant(request['terms']['expiresAt']) <= datetime.now(timezone.utc).timestamp():
                raise ClientError('Original checkout expired before dispatch')
            result = self.source('/pa/payments', {'handoff': request, 'selection': selection, 'approvedAmount': request['terms']['amount'], 'instrument': instrument}, authenticated=True)
            safe = self.safe_result(request, operation, route, result)
        except ClientError:
            safe = {'environment': 'sandbox', 'realPayment': False, 'handoffId': request['id'], 'handoffDigest': request['digest'], 'checkoutId': request['terms']['resource']['id'], 'operationId': operation, 'route': route, 'state': 'unknown', 'outcome': 'unknown'}
        self.db.execute('UPDATE payments SET state=?,result=? WHERE handoff=?', (safe['state'], json.dumps(safe), request['id'])); self.db.commit()
        return safe


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('command', choices=['capabilities', 'pay', 'query'])
    parser.add_argument('--task-id', required=True)
    args = parser.parse_args()
    executor = TestPayment(args.config)
    try:
        print(json.dumps(getattr(executor, args.command)(args.task_id), ensure_ascii=False))
    finally:
        executor.db.close()


if __name__ == '__main__':
    try:
        main()
    except (ClientError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        print(json.dumps({'error': str(error) if isinstance(error, ClientError) else 'Invalid isolated PA payment request or private ledger'}), file=sys.stderr)
        sys.exit(1)
