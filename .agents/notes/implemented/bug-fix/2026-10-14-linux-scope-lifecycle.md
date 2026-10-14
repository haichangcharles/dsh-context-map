# Agent Note: Complete cancelled Linux scope lifecycles

Status: implemented

English | [中文](2026-10-14-linux-scope-lifecycle.zh.md)

## Problem

Hosted Linux immediate-disposal diagnostics proved that the native user-systemd scope remained loaded and active for 90 seconds after successful TERM, replayed TERM, and KILL requests. The direct child had exited. The exact owned cgroup existed with `populated=0`, `TasksCurrent=0`, and zero live, zombie, dead, or unreadable direct members. This was an empty scope whose manager lifecycle remained running, not a missing escalation or a fallback containment result.

## Decision

After a successful final SIGKILL request, the [native owner](../../../../packages/subprocess/subprocess-local/src/linux-scope.ts) enqueues `systemctl --user stop --no-block` for its exact private scope. Pending-establishment cancellation replay includes this lifecycle request. TERM alone retains the existing grace interval and final escalation. Unrequested natural completion does not enqueue a stop.

The [systemctl manual](https://raw.githubusercontent.com/systemd/systemd/main/man/systemctl.xml) defines stop as deactivation and `--no-block` as job submission rather than completion. The [manager interface manual](https://raw.githubusercontent.com/systemd/systemd/main/man/org.freedesktop.systemd1.xml) distinguishes StopUnit from KillUnit, whose signalling can succeed for an empty cgroup. Therefore neither successful stop submission nor direct-child completion settles `waitForExit()`: the existing authoritative manager state observation still must prove range quiescence.

## Consequences

Rejected lifecycle requests remain observable when range exit is unproved. A collected or already inactive scope remains a valid exit proof; a missing stop target alone is not proof. Host-exit finalization attempts the same bounded synchronous submission even if its preceding kill throws, contains failures per owned range, and makes no quiescence claim.

## Alternatives considered

**Replace range waiting with the direct result.** This abandons ownership of descendants.

**Disable native containment or increase the timeout.** The recorded cgroup established real native containment; neither change completes the lifecycle.

**Write the cgroup directly or stop unrelated units.** Systemd owns the hierarchy. The request targets only this operation's private unit.

## Testing and limits

The public launch-owner regression failed before implementation because the final signal issued no stop request. It now proves that stop acknowledgement and direct exit leave the range pending until a manager state result arrives. All 44 owning scope tests pass; the complete scope module has 100% coverage of 204 statements, 178 branches, 40 functions, and 182 lines. Cases retain exact signal ordering, late establishment replay, unexpected bootstrap failures, natural-exit behaviour, rejected stop requests, successful recovery, collected units, and host-exit errors.

These platform-seam tests run on the development host without provider calls. They validate owner semantics, not the real hosted systemd response to the new request. Hosted native diagnostic and exhaustive CI reruns remain required before claiming the disposal failure is resolved.
