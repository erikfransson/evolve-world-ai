;; The two scans over the members' rows at the end of a tick (twins of the loops in Ecosystem.sharedPhase, which stay the reference and the fallback):
;; settle counts a tick alive for every creature with energy left and lists the others, and birthCandidates lists the members whose energy reaches their birth energy.
;; Offsets are layout.ts's (double-brace tokens). Keep in step with ecosystem.ts: tests/typescript/wasmMembers.test.ts compares them.
;; Memory is the brain bank's (imported).
(module
  (import "brain" "mem" (memory 1))

  ;; Members n-1 down to 0: ticksAlive + 1 when energy > 0 (NaN is not), else the member index into the list at M_OUT (descending), count at M_OUT_COUNT.
  (func (export "settle") (param $M i32)
    (local $i i32) (local $m i32) (local $row i32) (local $rowAt i32) (local $out i32)
    (local.set $i (i32.load offset={{M_N}} (local.get $M)))
    (local.set $rowAt (i32.load offset={{M_ROW_AT}} (local.get $M)))
    (local.set $out (i32.load offset={{M_OUT}} (local.get $M)))
    (block $done (loop $each
      (br_if $done (i32.le_s (local.get $i) (i32.const 0)))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (local.set $row (i32.shl (i32.load (i32.add (local.get $rowAt) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 3)))
      (if (f64.gt (f64.load offset={{R_ENERGY}} (local.get $row)) (f64.const 0))
        (then (f64.store offset={{R_TICKS}} (local.get $row) (f64.add (f64.load offset={{R_TICKS}} (local.get $row)) (f64.const 1))))
        (else
          (i32.store (i32.add (local.get $out) (i32.shl (local.get $m) (i32.const 2))) (local.get $i))
          (local.set $m (i32.add (local.get $m) (i32.const 1)))))
      (br $each)))
    (i32.store offset={{M_OUT_COUNT}} (local.get $M) (local.get $m))
  )

  ;; From member first on, round the list once: the members whose energy is not below their threshold (M_THRESHOLDS, f64 per member; a NaN energy counts), into M_OUT in that order.
  (func (export "birthCandidates") (param $M i32)
    (local $k i32) (local $n i32) (local $at i32) (local $m i32) (local $first i32) (local $rowAt i32) (local $out i32) (local $thresholds i32)
    (local.set $n (i32.load offset={{M_N}} (local.get $M)))
    (local.set $first (i32.load offset={{M_FIRST}} (local.get $M)))
    (local.set $rowAt (i32.load offset={{M_ROW_AT}} (local.get $M)))
    (local.set $out (i32.load offset={{M_OUT}} (local.get $M)))
    (local.set $thresholds (i32.load offset={{M_THRESHOLDS}} (local.get $M)))
    (local.set $at (local.get $first))
    (block $done (loop $each
      (br_if $done (i32.ge_s (local.get $k) (local.get $n)))
      (if (i32.eqz (f64.lt
            (f64.load offset={{R_ENERGY}} (i32.shl (i32.load (i32.add (local.get $rowAt) (i32.shl (local.get $at) (i32.const 2)))) (i32.const 3)))
            (f64.load (i32.add (local.get $thresholds) (i32.shl (local.get $at) (i32.const 3))))))
        (then
          (i32.store (i32.add (local.get $out) (i32.shl (local.get $m) (i32.const 2))) (local.get $at))
          (local.set $m (i32.add (local.get $m) (i32.const 1)))))
      ;; at = (first + k) % n, kept by stepping and wrapping
      (local.set $at (i32.add (local.get $at) (i32.const 1)))
      (if (i32.ge_s (local.get $at) (local.get $n)) (then (local.set $at (i32.const 0))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $each)))
    (i32.store offset={{M_OUT_COUNT}} (local.get $M) (local.get $m))
  )
)
