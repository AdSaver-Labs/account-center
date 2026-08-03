#!/usr/bin/env python3
"""Exact OpenClaw Codex-profile deletion with backups, rollback, and verification."""
import argparse, fcntl, hashlib, json, os, secrets, shutil, sqlite3, stat, sys, tempfile, time
from contextlib import contextmanager
from pathlib import Path

HOME = Path.home()
AGENTS = HOME / '.openclaw' / 'agents'
DEFAULT_ROOT = HOME / '.openclaw' / 'workspace' / '3-Resources' / 'codex-account-ops'


def private_state_root() -> Path:
    """Return private native-state root; permit a tightly-scoped fixture override.

    The override is intentionally environment-only so production argv remains
    stable. It is accepted only for an explicitly marked, tempfile-rooted HOME
    and can never direct private transaction artifacts outside that fixture.
    """
    override = os.environ.get('CODEX_AUTH_DELETE_TEST_STATE_ROOT')
    if not override:
        return DEFAULT_ROOT
    home = HOME.resolve()
    candidate = Path(override)
    resolved_candidate = candidate.resolve()
    tmp = Path(tempfile.gettempdir()).resolve()
    if (
        os.environ.get('CODEX_AUTH_DELETE_FIXTURE') != '1'
        or home.parent != tmp
        or not home.name.startswith('account-center-owned-delete-')
        or not resolved_candidate.is_relative_to(home)
    ):
        raise RuntimeError('fixture state-root override rejected')
    return candidate


ROOT = private_state_root()
BACKUPS = ROOT / 'state' / 'auth-delete-backups'
RECEIPTS = ROOT / 'state' / 'auth-delete-receipts'


def private_directory(path: Path) -> Path:
    """Create/repair an owner-only transaction directory without accepting links."""
    path.mkdir(parents=True, exist_ok=True)
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise RuntimeError('private transaction directory is unsafe')
    os.chmod(path, 0o700)
    return path


def private_transaction_tree() -> None:
    private_directory(ROOT)
    private_directory(ROOT / 'state')
    private_directory(BACKUPS)
    private_directory(RECEIPTS)


def private_regular_file(path: Path) -> bool:
    try:
        metadata = path.lstat()
        return stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode) and metadata.st_uid == os.getuid() and (metadata.st_mode & 0o077) == 0
    except FileNotFoundError:
        return False


@contextmanager
def operation_lock():
    """Serialize full native transactions so rollback cannot overwrite a peer write."""
    private_transaction_tree()
    lock_path = ROOT / 'state' / 'auth-delete.lock'
    flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(lock_path, flags, 0o600)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise RuntimeError('private transaction lock is unsafe')
        os.chmod(lock_path, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('another exact-account delete transaction is active') from error
        yield
    finally:
        os.close(fd)


def load(p, default):
    try: return json.loads(p.read_text())
    except FileNotFoundError: return default


def atom(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True); f=p.with_suffix(p.suffix+'.tmp'); f.write_text(json.dumps(obj,indent=2)+'\n'); os.chmod(f,0o600); f.replace(p)

def canonical(x):
    x=x.strip().lower(); return x if x.startswith('openai:') else 'openai:'+x.removeprefix('openai-codex:')
def profile_matches(pid,p,target): return canonical(pid)==target or str(p.get('email','')).lower()==target.removeprefix('openai:')
def profile_ids(profiles,target): return [pid for pid,p in profiles.get('profiles',{}).items() if profile_matches(pid,p,target)]
def clean_state(s, ids):
    ids=set(ids); aliases=ids|{'openai-codex:'+x.split(':',1)[1] for x in ids if ':' in x}
    for provider, order in list((s.get('order') or {}).items()): s['order'][provider]=[x for x in order if x not in aliases]
    for provider, value in list((s.get('lastGood') or {}).items()):
        if value in aliases: s['lastGood'].pop(provider,None)
    return s


def sqlite_remove(db,target):
    ids=[]
    con=sqlite3.connect(db); con.execute('BEGIN IMMEDIATE')
    try:
        row=con.execute("select store_json from auth_profile_store where store_key='primary'").fetchone()
        if row:
            s=json.loads(row[0]); ids=profile_ids(s,target)
            for i in ids: s.get('profiles',{}).pop(i,None)
            con.execute("update auth_profile_store set store_json=?, updated_at=? where store_key='primary'",(json.dumps(s),int(time.time()*1000)))
        row=con.execute("select state_json from auth_profile_state where state_key='primary'").fetchone()
        if row:
            s=clean_state(json.loads(row[0]), ids); con.execute("update auth_profile_state set state_json=?, updated_at=? where state_key='primary'",(json.dumps(s),int(time.time()*1000)))
        con.commit(); return ids
    except Exception: con.rollback(); raise
    finally: con.close()
def sqlite_has(db,target):
    con=sqlite3.connect(db)
    try:
        row=con.execute("select store_json from auth_profile_store where store_key='primary'").fetchone()
        return bool(row and profile_ids(json.loads(row[0]),target))
    finally: con.close()


def main():
    p=argparse.ArgumentParser(); p.add_argument('target'); p.add_argument('--apply',action='store_true'); a=p.parse_args(); target=canonical(a.target)
    agents=[]
    for d in AGENTS.iterdir():
        ad=d/'agent'; jp=ad/'auth-profiles.json'; db=ad/'openclaw-agent.sqlite'
        if private_regular_file(jp) or private_regular_file(db): agents.append((d.name,jp,db))
    observed=[]
    for name,jp,db in agents:
        json_present, db_present = private_regular_file(jp), private_regular_file(db)
        ids=profile_ids(load(jp,{'profiles':{}}),target) if json_present else []
        if db_present and sqlite_has(db,target): ids=list(set(ids+[target]))
        if ids: observed.append((name,jp,db,ids))
    if not observed: print(json.dumps({'state':'BLOCKED','reason':'exact connected account not found'})); return 2
    receipt={'action':'account.delete','state':'PREVIEW','targetDigest':hashlib.sha256(target.encode()).hexdigest()[:16],'agents':[x[0] for x in observed],'backup':False,'verified':False}
    if not a.apply: print(json.dumps(receipt)); return 0
    operation_id = time.strftime('%Y%m%dT%H%M%SZ',time.gmtime()) + '-' + secrets.token_hex(8)
    copies=[]; backup_started=False
    try:
        with operation_lock():
            backup=BACKUPS/operation_id; backup.mkdir(mode=0o700, exist_ok=False); os.chmod(backup, 0o700); backup_started=True
            for name,jp,db,_ in observed:
                for src in (jp,db):
                    if src.exists():
                        if not private_regular_file(src): raise RuntimeError('credential source is unsafe')
                        dst=backup/(name+'-'+src.name); shutil.copy2(src,dst); os.chmod(dst,0o600); copies.append((src,dst))
            for _,jp,db,ids in observed:
                if jp.exists():
                    s=load(jp,{'version':1,'profiles':{}})
                    for i in ids: s.get('profiles',{}).pop(i,None)
                    atom(jp,s)
                    if os.environ.get('CODEX_AUTH_DELETE_TEST_FAIL_AFTER') == 'json': raise RuntimeError('forced fixture failure after JSON mutation')
                if db.exists():
                    sqlite_remove(db,target)
                    if os.environ.get('CODEX_AUTH_DELETE_TEST_FAIL_AFTER') == 'sqlite': raise RuntimeError('forced fixture failure after SQLite mutation')
            if any(profile_ids(load(jp,{'profiles':{}}),target) or (db.exists() and sqlite_has(db,target)) for _,jp,db,_ in observed): raise RuntimeError('post-delete verification failed')
            receipt.update({'state':'DELETED','backup':True,'verified':True})
            atom(RECEIPTS/(operation_id+'.json'),receipt)
    except Exception:
        for src,dst in copies: shutil.copy2(dst,src)
        receipt.update({'state':'UNPROVEN','backup':backup_started,'verified':False,'reason':'rollback performed'})
        try:
            private_transaction_tree()
            atom(RECEIPTS/(operation_id+'.json'),receipt)
        except Exception:
            pass
        print(json.dumps(receipt)); return 1
    print(json.dumps(receipt)); return 0
if __name__=='__main__': sys.exit(main())
