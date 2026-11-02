#!/usr/bin/env python3
"""Check installed public Skill files; host activation remains a separate report."""
import argparse
import hashlib
import json
import os
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

FILES = {
    'SKILL.md', 'connection.json', 'references/a2a.md', 'references/relay.md',
    'references/test-payments.md', 'scripts/eigos_a2a.py',
    'scripts/eigos_test_payment.py', 'scripts/check_connection.py',
}
LIMIT = 512 * 1024


class CheckError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CheckError('DISCOVERY_REDIRECT_REJECTED')


def read_file(root, name):
    if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        raise CheckError('SAFE_FILE_CHECK_UNAVAILABLE')
    descriptors = []
    try:
        parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(parent)
        parts = name.split('/')
        for part in parts[:-1]:
            parent = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            descriptors.append(parent)
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        descriptors.append(fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > LIMIT:
            raise CheckError('SKILL_FILE_UNSAFE')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            body = stream.read(LIMIT + 1)
        if len(body) > LIMIT:
            raise CheckError('SKILL_FILE_UNSAFE')
        return body
    except OSError:
        raise CheckError('SKILL_FILE_UNSAFE') from None
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def manifest(raw):
    value = json.loads(raw)
    if (not isinstance(value, dict) or value.get('schema') != 'eigos.skill-manifest/1'
            or value.get('name') != 'eigos-delegate'
            or not isinstance(value.get('version'), str)
            or value.get('marker') != 'eigos-delegate@' + value['version']):
        raise CheckError('SKILL_MANIFEST_INVALID')
    entries = value.get('files')
    if (not isinstance(entries, list) or len(entries) != len(FILES)
            or any(not isinstance(e, dict) for e in entries)
            or {e.get('path') for e in entries} != FILES):
        raise CheckError('SKILL_MANIFEST_INVALID')
    encoded = json.dumps(entries, ensure_ascii=False, separators=(',', ':')).encode()
    if hashlib.sha256(encoded).hexdigest() != value.get('packageDigest'):
        raise CheckError('SKILL_MANIFEST_INVALID')
    for entry in entries:
        if (type(entry.get('bytes')) is not int or not 0 <= entry['bytes'] <= LIMIT
                or not isinstance(entry.get('sha256'), str)
                or len(entry['sha256']) != 64):
            raise CheckError('SKILL_MANIFEST_INVALID')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--loaded-marker', help='Marker reported from the host-loaded instructions, not a remote file')
    parser.add_argument('--allow-loopback-http', action='store_true', help='For isolated local acceptance only')
    args = parser.parse_args()
    origin = urllib.parse.urlsplit(args.origin)
    local_http = (args.allow_loopback_http and origin.scheme == 'http'
                  and origin.hostname in ('127.0.0.1', 'localhost', '::1'))
    if ((origin.scheme != 'https' and not local_http) or not origin.hostname
            or origin.username or origin.password or origin.query or origin.fragment
            or origin.path not in ('', '/')):
        raise CheckError('EXPLICIT_ORIGIN_REQUIRED')
    canonical = urllib.parse.urlunsplit((origin.scheme, origin.netloc, '', '', ''))
    if args.directory.is_symlink():
        raise CheckError('SKILL_DIRECTORY_UNSAFE')
    root = args.directory.resolve(strict=True)
    installed = manifest(read_file(root, 'manifest.json'))
    if installed.get('origin') != canonical:
        raise CheckError('SKILL_ORIGIN_MISMATCH')
    # No authentication, configuration files or supplier credentials are read.
    request = urllib.request.Request(canonical + '/connect/manifest.json',
                                    headers={'Accept': 'application/json',
                                             'User-Agent': 'EIGOS-Connection-Check/1.0'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
            raw = response.read(LIMIT + 1)
    except urllib.error.HTTPError as error:
        raise CheckError('PUBLIC_DISCOVERY_BLOCKED' if error.code == 403 else 'PUBLIC_DISCOVERY_UNAVAILABLE') from None
    if len(raw) > LIMIT:
        raise CheckError('SKILL_MANIFEST_INVALID')
    current = manifest(raw)
    if current.get('origin') != canonical:
        raise CheckError('SKILL_ORIGIN_MISMATCH')
    modified = []
    for entry in installed['files']:
        body = read_file(root, entry['path'])
        if len(body) != entry['bytes'] or hashlib.sha256(body).hexdigest() != entry['sha256']:
            modified.append(entry['path'])
    files_current = (not modified and installed['packageDigest'] == current['packageDigest']
                     and installed['version'] == current['version'] and installed['marker'] == current['marker'])
    activation = ('unconfirmed' if args.loaded_marker is None else
                  'self_reported_current' if args.loaded_marker == current['marker']
                  and files_current else 'reported_outdated')
    print(json.dumps({
        'schema': 'eigos.skill-check/1', 'origin': canonical,
        'installedVersion': installed['version'], 'publishedVersion': current['version'],
        'fileIntegrity': 'modified' if modified else 'verified',
        'filesCurrent': files_current, 'hostActivation': activation,
        'hostActivationIsSelfReport': args.loaded_marker is not None,
        'nextAction': ('refresh_skill_in_host' if not files_current or activation == 'reported_outdated'
                       else 'confirm_loaded_in_host' if activation == 'unconfirmed'
                       else 'check_authenticated_connection'),
        'credentialsRead': False, 'taskCreated': False,
    }, ensure_ascii=False))
    return 0 if files_current and activation != 'reported_outdated' else 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except CheckError as error:
        print(json.dumps({'error': str(error), 'credentialsRead': False, 'taskCreated': False}))
        sys.exit(2)
    except (OSError, ValueError, TypeError, KeyError, urllib.error.URLError):
        print(json.dumps({'error': 'CONNECTION_CHECK_UNAVAILABLE', 'credentialsRead': False, 'taskCreated': False}))
        sys.exit(2)
