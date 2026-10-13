# Agent Note: Preserve in-Turn human corrections during Branch relocation

Status: implemented

English | [中文](2026-10-14-complete-human-turn-relocation.zh.md)

## Problem

A user can steer an active Turn with a correction. Question/answer relocation previously selected the first human input and final answer, so accepting a relocation could omit the correction that produced that answer.

## Decision

Offer pair relocation only when the completed Turn contains exactly one appended direct-human message and a visible final assistant output. Multi-input Turns keep their original conversation. Native Branch and Branch from here still fork the complete prefix; their behavior is unchanged.

## Alternatives considered

**Copy only the first input and last output.** The new branch would lose the user's correction.

**Concatenate human inputs.** This would replace distinct authored events with invented message text and change the relocation format.

## Consequences

Some completed Turns no longer receive a pair-relocation suggestion. The user can still fork their complete conversation, and no input or patch is discarded.

## Testing

A real AgentLoop fixture blocks a native tool, delivers a correction through public `agent.steer`, completes the Turn and verifies that no incomplete pair candidate is returned. Ordinary one-input relocation, images, failed Turns and native whole-prefix forks remain covered. The fixture uses no provider API.
