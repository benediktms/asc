# Local deployment and lifecycle

Status: implemented v1 scope for macOS and Linux.

## Installation layout

`acs install --prefix <prefix>` installs the invoking standalone executable at:

```text
<prefix>/lib/acs/versions/<version>/<os>-<arch>/acs
<prefix>/bin/acs -> ../lib/acs/versions/<version>/<os>-<arch>/acs
```

The file is completely copied and permissioned before rename. The PATH link is
also created under a temporary name and atomically renamed. ASC refuses a
prefix, binary directory, or version directory owned by another user or
writable by the group/world. It will not replace a regular PATH entry or a
symlink whose target lacks ASC's ownership marker.

The current daemon is not restarted during installation. POSIX keeps its open
executable image valid while the PATH link moves to the new version; an explicit
`acs daemon restart` opts into the new image.

The per-user data directory contains an installation record used by
`acs codex install-mcp` and conservative uninstall. Uninstall validates the
record, link target, and ownership marker, then removes only the link and that
version/target directory. It never deletes configuration, SQLite data, logs,
tokens, or secrets.

## Platform paths

| Purpose            | Linux                                                                   | macOS                               |
| ------------------ | ----------------------------------------------------------------------- | ----------------------------------- |
| Configuration      | `$XDG_CONFIG_HOME/acs` or `~/.config/acs`                               | `~/Library/Application Support/acs` |
| Data and lifecycle | `$XDG_DATA_HOME/acs` or `~/.local/share/acs`                            | `~/Library/Application Support/acs` |
| Control socket     | `$XDG_RUNTIME_DIR/acs/control.sock` or `$TMPDIR/acs-<uid>/control.sock` | `$TMPDIR/acs-<uid>/control.sock`    |
| Logs               | `<data>/logs`                                                           | `<data>/logs`                       |

`ACS_HOME`, `ACS_CONFIG_PATH`, `ACS_STORAGE_PATH`, and `ACS_CONTROL_SOCKET`
remain available for isolated deployments and tests. Runtime directories are
mode `0700`; records, tokens, secrets, and sockets are current-user-only.

## Process ownership and recovery

Mutating lifecycle operations use an atomic per-user lock directory. `start` is
idempotent while a matching daemon is live, including concurrent invocations.
The process record contains PID, random instance ID, OS process-start marker,
resolved executable, version, and timestamp. A process is considered owned only
when PID, start marker, executable identity, and the `daemon run` command all
match. ASC never signals a process based on PID alone.

If no matching process exists, ASC removes stale records and Unix sockets. A
non-socket object at the configured socket path is never removed automatically.
`start` waits for authenticated control-plane health before returning success.
`stop` asks the control plane to shut down, waits three seconds, then uses TERM
and finally KILL with identity revalidation before each signal.

## Logs

Detached stdout and stderr append to `logs/daemon.log`. At each start, a file of
5 MiB or larger is rotated to `.1`; three historical files are retained. Log
files and their directory are private to the current user.

Native service managers, multi-user operation, automatic updates, Windows, and
automatic daemon restart during binary upgrades remain out of scope.
