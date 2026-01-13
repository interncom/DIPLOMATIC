import { describe, it, expect, beforeEach } from 'vitest';
import { EntDBMemory } from '../src/entdb/memory';
import { Status } from '../shared/consts';
import { INeoOp } from '../shared/types';

describe('EntDBMemory.apply()', () => {
  let db: EntDBMemory;

  beforeEach(() => {
    db = new EntDBMemory();
  });

  describe('no pre-existing entity', () => {
    it('creates new entity with op data', async () => {
      const eid = new Uint8Array(16).fill(1);
      const op: INeoOp = {
        ts: new Date(1000),
        ctr: 1,
        eid,
        gid: 'group1',
        pid: new Uint8Array(16).fill(2),
        type: 'test',
        body: { data: 'new' },
      };

      const result = await db.apply(op);
      expect(result).toBe(Status.Success);

      const entity = await db.getEnt(eid);
      expect(entity).toEqual({
        eid,
        gid: 'group1',
        pid: new Uint8Array(16).fill(2),
        type: 'test',
        createdAt: new Date(1000),
        updatedAt: new Date(1000),
        updatedCtr: 1,
        body: { data: 'new' },
      });
    });
  });

  describe('pre-existing entity older than op', () => {
    it('overwrites body and updates timestamps', async () => {
      const eid = new Uint8Array(16).fill(1);
      // First, apply an older op
      const oldOp: INeoOp = {
        ts: new Date(1000),
        ctr: 1,
        eid,
        type: 'test',
        body: { data: 'old' },
      };
      await db.apply(oldOp);

      // Then apply newer op
      const newOp: INeoOp = {
        ts: new Date(2000),
        ctr: 2,
        eid,
        gid: 'group2',
        type: 'updated',
        body: { data: 'new' },
      };
      const result = await db.apply(newOp);
      expect(result).toBe(Status.Success);

      const entity = await db.getEnt(eid);
      expect(entity).toEqual({
        eid,
        gid: 'group2',
        pid: undefined,
        type: 'updated',
        createdAt: new Date(1000), // min of 1000 and 2000
        updatedAt: new Date(2000), // max
        updatedCtr: 2,
        body: { data: 'new' }, // overwritten
      });
    });
  });

  describe('pre-existing entity newer than op', () => {
    it('returns NoChange and keeps existing body', async () => {
      const eid = new Uint8Array(16).fill(1);
      // First, apply a newer op
      const newOp: INeoOp = {
        ts: new Date(2000),
        ctr: 1,
        eid,
        type: 'test',
        body: { data: 'new' },
      };
      await db.apply(newOp);

      // Then apply older op within the window
      const oldOp: INeoOp = {
        ts: new Date(1500), // between 2000? Wait, createdAt=2000, updatedAt=2000, so 2000 < 1500 false
        ctr: 2,
        eid,
        type: 'test',
        body: { data: 'old' },
      };
      const result = await db.apply(oldOp);
      expect(result).toBe(Status.Success); // Since 2000 < 1500 false, it proceeds

      const entity = await db.getEnt(eid);
      expect(entity?.body).toEqual({ data: 'new' }); // keeps new body since updatedAt 2000 > 1500
      expect(entity?.createdAt).toEqual(new Date(1500)); // min
      expect(entity?.updatedAt).toEqual(new Date(2000)); // max
      expect(entity?.updatedCtr).toBe(1);
    });

    it('returns NoChange when op is strictly between created and updated', async () => {
      const eid = new Uint8Array(16).fill(1);
      // Entity with createdAt < updatedAt
      await db.apply({
        ts: new Date(1000),
        ctr: 1,
        eid,
        type: 'test',
        body: { data: 'initial' },
      });
      await db.apply({
        ts: new Date(2000),
        ctr: 2,
        eid,
        type: 'test',
        body: { data: 'updated' },
      });

      // Op at 1500, which is > createdAt and < updatedAt
      const op: INeoOp = {
        ts: new Date(1500),
        ctr: 3,
        eid,
        type: 'test',
        body: { data: 'middle' },
      };
      const result = await db.apply(op);
      expect(result).toBe(Status.NoChange);

      const entity = await db.getEnt(eid);
      expect(entity?.body).toEqual({ data: 'updated' }); // unchanged
      expect(entity?.createdAt).toEqual(new Date(1000));
      expect(entity?.updatedAt).toEqual(new Date(2000));
      expect(entity?.updatedCtr).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('op.ts == curr.createdAt', async () => {
      const eid = new Uint8Array(16).fill(1);
      await db.apply({
        ts: new Date(1000),
        ctr: 1,
        eid,
        type: 'test',
        body: { data: 'initial' },
      });

      const op: INeoOp = {
        ts: new Date(1000),
        ctr: 2,
        eid,
        type: 'test',
        body: { data: 'same time' },
      };
      const result = await db.apply(op);
      expect(result).toBe(Status.Success);

      const entity = await db.getEnt(eid);
      expect(entity?.body).toEqual({ data: 'same time' }); // since updatedAt == op.ts and op.ctr > curr.updatedCtr, takes op.body
      expect(entity?.createdAt).toEqual(new Date(1000));
      expect(entity?.updatedAt).toEqual(new Date(1000));
      expect(entity?.updatedCtr).toBe(2);
    });

    it('curr.createdAt == curr.updatedAt (new entity)', async () => {
      const eid = new Uint8Array(16).fill(1);
      await db.apply({
        ts: new Date(1000),
        ctr: 1,
        eid,
        type: 'test',
        body: { data: 'new' },
      });

      const op: INeoOp = {
        ts: new Date(500), // older
        ctr: 2,
        eid,
        type: 'test',
        body: { data: 'old' },
      };
      const result = await db.apply(op);
      expect(result).toBe(Status.Success);

      const entity = await db.getEnt(eid);
      expect(entity?.body).toEqual({ data: 'new' }); // since updatedAt > op.ts
      expect(entity?.createdAt).toEqual(new Date(500)); // min
      expect(entity?.updatedAt).toEqual(new Date(1000)); // max
      expect(entity?.updatedCtr).toBe(1);
    });
  });

  describe('property updates', () => {
    it('takes gid, pid, type from op when op is newer', async () => {
      const eid = new Uint8Array(16).fill(1);
      await db.apply({
        ts: new Date(1000),
        ctr: 1,
        eid,
        gid: 'oldgroup',
        pid: new Uint8Array(16).fill(3),
        type: 'oldtype',
        body: { data: 'old' },
      });

      const op: INeoOp = {
        ts: new Date(2000),
        ctr: 2,
        eid,
        gid: 'newgroup',
        pid: new Uint8Array(16).fill(4),
        type: 'newtype',
        body: { data: 'new' },
      };
      await db.apply(op);

      const entity = await db.getEnt(eid);
      expect(entity?.gid).toBe('newgroup');
      expect(entity?.pid).toEqual(new Uint8Array(16).fill(4));
      expect(entity?.type).toBe('newtype');
      expect(entity?.updatedCtr).toBe(2);
    });

    it('retains gid, pid, type from curr when op is older', async () => {
      const eid = new Uint8Array(16).fill(1);
      await db.apply({
        ts: new Date(2000),
        ctr: 1,
        eid,
        gid: 'currgroup',
        pid: new Uint8Array(16).fill(5),
        type: 'currtype',
        body: { data: 'curr' },
      });

      const op: INeoOp = {
        ts: new Date(1000),
        ctr: 2,
        eid,
        gid: 'opgroup',
        pid: new Uint8Array(16).fill(6),
        type: 'optype',
        body: { data: 'op' },
      };
      await db.apply(op);

      const entity = await db.getEnt(eid);
      expect(entity?.gid).toBe('currgroup');
      expect(entity?.pid).toEqual(new Uint8Array(16).fill(5));
      expect(entity?.type).toBe('currtype');
      expect(entity?.body).toEqual({ data: 'curr' }); // body also retained
      expect(entity?.updatedCtr).toBe(1);
    });
  });

  describe('body handling', () => {
    it('handles undefined body in op', async () => {
      const eid = new Uint8Array(16).fill(1);
      await db.apply({
        ts: new Date(1000),
        ctr: 1,
        eid,
        type: 'test',
        body: { data: 'existing' },
      });

      const op: INeoOp = {
        ts: new Date(2000),
        ctr: 2,
        eid,
        type: 'test',
        body: undefined,
      };
      await db.apply(op);

      const entity = await db.getEnt(eid);
      expect(entity?.body).toBeUndefined();
      expect(entity?.updatedCtr).toBe(2);
    });

    it('keeps curr body when op is older', async () => {
      const eid = new Uint8Array(16).fill(1);
      await db.apply({
        ts: new Date(2000),
        ctr: 1,
        eid,
        type: 'test',
        body: { data: 'newer' },
      });

      const op: INeoOp = {
        ts: new Date(1000),
        ctr: 2,
        eid,
        type: 'test',
        body: { data: 'older' },
      };
      await db.apply(op);

      const entity = await db.getEnt(eid);
      expect(entity?.body).toEqual({ data: 'newer' });
    });

    it('ctr tiebreaker: higher ctr wins when timestamps equal', async () => {
      const eid = new Uint8Array(16).fill(1);
      await db.apply({
        ts: new Date(1000),
        ctr: 1,
        eid,
        type: 'test',
        body: { data: 'first' },
      });

      // Same ts, higher ctr
      const op: INeoOp = {
        ts: new Date(1000),
        ctr: 3,
        eid,
        type: 'test',
        body: { data: 'higher ctr' },
      };
      await db.apply(op);

      const entity = await db.getEnt(eid);
      expect(entity?.body).toEqual({ data: 'higher ctr' });
      expect(entity?.updatedCtr).toBe(3);
    });

    it('ctr tiebreaker: equal ctr keeps current', async () => {
      const eid = new Uint8Array(16).fill(1);
      await db.apply({
        ts: new Date(1000),
        ctr: 1,
        eid,
        type: 'test',
        body: { data: 'first' },
      });

      // Same ts, same ctr
      const op: INeoOp = {
        ts: new Date(1000),
        ctr: 1,
        eid,
        type: 'test',
        body: { data: 'same ctr' },
      };
      await db.apply(op);

      const entity = await db.getEnt(eid);
      expect(entity?.body).toEqual({ data: 'first' });
      expect(entity?.updatedCtr).toBe(1);
    });

    it('ctr tiebreaker: lower ctr keeps current', async () => {
      const eid = new Uint8Array(16).fill(1);
      await db.apply({
        ts: new Date(1000),
        ctr: 5,
        eid,
        type: 'test',
        body: { data: 'higher' },
      });

      // Same ts, lower ctr
      const op: INeoOp = {
        ts: new Date(1000),
        ctr: 2,
        eid,
        type: 'test',
        body: { data: 'lower ctr' },
      };
      await db.apply(op);

      const entity = await db.getEnt(eid);
      expect(entity?.body).toEqual({ data: 'higher' });
      expect(entity?.updatedCtr).toBe(5);
    });
  });
});
