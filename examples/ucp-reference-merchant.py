"""Run the pinned, unmodified official UCP Python merchant on loopback only.

Use the official sample's .venv Python after `uv sync` in rest/python/server.
This launcher changes only binding/configuration and initializes a new test DB.
It never connects to a real merchant or payment processor.
"""

import argparse
import pathlib
import subprocess
import sys

REFERENCE_COMMIT = "b7d7a5496d61650e0780f4d1f87684e10f811562"
parser = argparse.ArgumentParser()
parser.add_argument("--reference-dir", type=pathlib.Path, required=True)
parser.add_argument("--data-dir", type=pathlib.Path, required=True)
parser.add_argument("--port", type=int, required=True)
args = parser.parse_args()
reference = args.reference_dir.resolve()
data = args.data_dir.resolve()
if not 1024 <= args.port <= 65535:
    raise ValueError("Use an explicit unprivileged loopback port")
actual = subprocess.check_output(["git", "-C", str(reference), "rev-parse", "HEAD"], text=True).strip()
if actual != REFERENCE_COMMIT:
    raise ValueError("The official reference checkout does not match the verified commit")
subprocess.run(["git", "-C", str(reference), "diff", "--exit-code", "--quiet"], check=True)
server_dir = reference / "rest/python/server"
data.mkdir(parents=True, exist_ok=True)
products, transactions = data / "products.db", data / "transactions.db"
if products.exists() != transactions.exists():
    raise ValueError("Incomplete reference DB pair; preserve it and choose a new test directory")
if not products.exists():
    subprocess.run([
        sys.executable, str(server_dir / "import_csv.py"),
        f"--products_db_path={products}", f"--transactions_db_path={transactions}",
        f"--data_dir={reference / 'rest/python/test_data/flower_shop'}",
    ], cwd=server_dir, check=True)

sys.path.insert(0, str(server_dir))
import config  # noqa: E402
config.FLAGS([
    "eigos-reference-merchant", f"--products_db_path={products}",
    f"--transactions_db_path={transactions}", f"--port={args.port}",
    "--require_signatures", "--allow_insecure_profile_urls",
])
from server import app  # noqa: E402
import uvicorn  # noqa: E402

uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
