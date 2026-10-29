;; Whole Ecosystem sense in one call: per creature the ray directions, item and wall rays (f64, same arithmetic and candidate order as World.castRays),
;; the crowd rays (f32), and the ray features written straight into the brain input vector.
;; Memory is the brain bank's (imported), so inputs need no copy. Everything is scratch per tick except the per-slot offset tables.
;; Param block P (layout.ts S_*, double-brace tokens below): the world's item grid (itemStart is cols+1 per row, absolute; itemXY f32 pairs; itemKind u8; items packed per row in cell order),
;;   the crowd grid (cStart, sx, sy, own, sig, species: i32 per crowd slot), the creature records (rec, n), the brain input stride (ray features are 4 + S + 1 per ray: S species flags, then the energy),
;;   the candidate and ray scratch (cand, scr).
;; Rock (Terrain, as World.gatherRock): rockMaxR, invRockCell, rockCols (0 for no rock), rockRows, rockStart (cols*rows+1), rockOrder, rockXYR (f64 x y r per disc).
;;   Rock discs join the item candidates as kind 3 (wall), after the items, so a ray reports the nearest of wall, rock, item and creature.
;; Candidate walks keep an item or disc only inside the ray distance and inside the wedge of the two outer rays widened by the radius (everything when the rays span 180 degrees or more); the crowd walk does the same in f32.
;; Early-out: a creature with no item, rock disc or creature candidate, no wall in range and no detail record writes all-zero features and skips the ray passes.
;; Otherwise each candidate is first tested against two rays at a time (f64x2) by the distance s of the ray to the centre, and only the rays that pass run the exact hit test, in candidate order.
;; A creature with no creature candidate and no detail record takes the f64 results straight to features; the rest run the crowd rays (f32x4, four rays at a time) and merge the hits.
;; Creature record, 64 bytes (layout.ts REC_*, double-brace tokens below): f64 x y cos sin L; i32 self, rays, offsets (f64 cos[rays], then sin[rays]), input (byte address),
;;   detail (0, or the address where to also write each ray as f64 closeness, i32 kind, i32 crowd slot hit or -1, for the UI).
;; Ray scratch (max 64 rays): dx f64@0 dy f64@512 clo f64@1024 kind i32@1536 dxf f32@1792 dyf f32@2048 best f32@2304 hit i32@2560.
;;   For an odd ray count dx and dy at index nR are NaN, so the unused lane of the last pair never passes the prefilter.
;; patchItems (separate export): resizes the packed item cells of the item grid in place, one call per tick for all dirty cells, instead of a JS patch per cell.
(module
  (import "brain" "mem" (memory 1))

  ;; Per-ray passes two rays per step as f64x2, the same per-lane operations as the scalar loops of $sense below, so the results are bit-identical.
  ;; Each pair helper returns the rays it did (nR rounded down to even); the scalar loop after the call does the odd last ray.
  ;; $dirsPairs: ray directions by angle addition; with init (no wall in range) also best = L and kind 0 per ray, which is all the wall pass would leave.
  (func $dirsPairs (param $scr i32) (param $off i32) (param $nR i32) (param $hc f64) (param $hs f64) (param $init i32) (param $L f64) (result i32)
    (local $i i32) (local $hcv v128) (local $hsv v128) (local $c v128) (local $s v128) (local $p i32) (local $Lv v128)
    (local.set $Lv (f64x2.splat (local.get $L)))
    (local.set $hcv (f64x2.splat (local.get $hc)))
    (local.set $hsv (f64x2.splat (local.get $hs)))
    (block $d (loop $l
      (br_if $d (i32.gt_s (i32.add (local.get $i) (i32.const 2)) (local.get $nR)))
      (local.set $c (v128.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
      (local.set $s (v128.load (i32.add (local.get $off) (i32.shl (i32.add (local.get $nR) (local.get $i)) (i32.const 3)))))
      (local.set $p (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3))))
      (v128.store (local.get $p) (f64x2.sub (f64x2.mul (local.get $hcv) (local.get $c)) (f64x2.mul (local.get $hsv) (local.get $s))))
      (v128.store offset=512 (local.get $p) (f64x2.add (f64x2.mul (local.get $hsv) (local.get $c)) (f64x2.mul (local.get $hcv) (local.get $s))))
      (if (local.get $init) (then
        (v128.store offset=1024 (local.get $p) (local.get $Lv))
        (i64.store offset=1536 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2))) (i64.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 2)))
      (br $l)))
    (local.get $i))

  ;; $closePairs: closeness (0 for kind 0, else 1 - best / L) per ray.
  (func $closePairs (param $scr i32) (param $L f64) (param $nR i32) (result i32)
    (local $i i32) (local $Lv v128) (local $one v128) (local $z v128) (local $p8 i32) (local $p4 i32)
    (local.set $Lv (f64x2.splat (local.get $L)))
    (local.set $one (f64x2.splat (f64.const 1)))
    (block $d (loop $l
      (br_if $d (i32.gt_s (i32.add (local.get $i) (i32.const 2)) (local.get $nR)))
      (local.set $p8 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3))))
      (local.set $p4 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2))))
      (local.set $z (i64x2.eq (i64x2.extend_low_i32x4_s (v128.load64_zero offset=1536 (local.get $p4))) (v128.const i64x2 0 0)))
      (v128.store offset=1024 (local.get $p8) (v128.andnot (f64x2.sub (local.get $one) (f64x2.div (v128.load offset=1024 (local.get $p8)) (local.get $Lv))) (local.get $z)))
      (local.set $i (i32.add (local.get $i) (i32.const 2)))
      (br $l)))
    (local.get $i))

  ;; $crowdPrep: per ray the f32 direction and start distance the crowd rays read, and the padding lanes of the last group of four.
  (func $crowdPrep (param $scr i32) (param $L f64) (param $nR i32)
    (local $i i32) (local $Lv v128) (local $one v128) (local $z v128) (local $clo v128) (local $p8 i32) (local $p4 i32)
    (local.set $Lv (f64x2.splat (local.get $L)))
    (local.set $one (f64x2.splat (f64.const 1)))
    (block $d (loop $l
      (br_if $d (i32.gt_s (i32.add (local.get $i) (i32.const 2)) (local.get $nR)))
      (local.set $p8 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3))))
      (local.set $p4 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2))))
      (local.set $z (i64x2.eq (i64x2.extend_low_i32x4_s (v128.load64_zero offset=1536 (local.get $p4))) (v128.const i64x2 0 0)))
      (local.set $clo (v128.load offset=1024 (local.get $p8)))
      (v128.store64_lane offset=1792 0 (local.get $p4) (f32x4.demote_f64x2_zero (v128.load (local.get $p8))))
      (v128.store64_lane offset=2048 0 (local.get $p4) (f32x4.demote_f64x2_zero (v128.load offset=512 (local.get $p8))))
      (v128.store64_lane offset=2304 0 (local.get $p4)
        (f32x4.demote_f64x2_zero (v128.bitselect (local.get $Lv) (f64x2.mul (f64x2.sub (local.get $one) (local.get $clo)) (local.get $Lv)) (local.get $z))))
      (local.set $i (i32.add (local.get $i) (i32.const 2)))
      (br $l)))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_s (local.get $i) (local.get $nR)))
      (local.set $p8 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3))))
      (local.set $p4 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2))))
      (f32.store offset=1792 (local.get $p4) (f32.demote_f64 (f64.load (local.get $p8))))
      (f32.store offset=2048 (local.get $p4) (f32.demote_f64 (f64.load offset=512 (local.get $p8))))
      (f32.store offset=2304 (local.get $p4)
        (f32.demote_f64 (select (local.get $L) (f64.mul (f64.sub (f64.const 1) (f64.load offset=1024 (local.get $p8))) (local.get $L)) (i32.eqz (i32.load offset=1536 (local.get $p4))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (local.set $i (local.get $nR))
    (block $pd (loop $pl
      (br_if $pd (i32.eqz (i32.and (local.get $i) (i32.const 3))))
      (f32.store offset=1792 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2))) (f32.const 0))
      (f32.store offset=2048 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2))) (f32.const 0))
      (f32.store offset=2304 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2))) (f32.demote_f64 (local.get $L)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $pl))))

  ;; $unseen: 1 when none of the nR rays hit a creature (crowd hit -1 in every real lane, the padding lanes of the last group do not count).
  (func $unseen (param $scr i32) (param $nR i32) (result i32)
    (local $i i32) (local $v v128) (local $rem i32)
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $nR)))
      (local.set $v (v128.load offset=2560 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2)))))
      (local.set $rem (i32.sub (local.get $nR) (local.get $i)))
      (if (i32.lt_s (local.get $rem) (i32.const 4)) (then
        (local.set $v (v128.or (local.get $v) (v128.not (i32x4.gt_s (i32x4.splat (local.get $rem)) (v128.const i32x4 0 1 2 3)))))))
      (if (v128.any_true (v128.not (local.get $v))) (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 4)))
      (br $l)))
    (i32.const 1))

  ;; $emit: the features of nR rays that saw no creature: closeness and the one-hot of food, poison and wall, then zeros (species flags and seen energy).
  ;; Closeness is read from scratch when calc is 0, else computed per ray from best and kind (0 for kind 0, else 1 - best / L).
  (func $emit (param $scr i32) (param $base i32) (param $nR i32) (param $stride i32) (param $L f64) (param $calc i32)
    (local $i i32) (local $kind i32) (local $clo f64) (local $z i32) (local $kinds v128) (local $ones v128) (local $Lv v128) (local $one v128) (local $kk v128) (local $cv v128) (local $oa v128) (local $ob v128)
    ;; constants in locals: V8 rebuilds a v128 constant at each use inside a loop
    (local.set $kinds (v128.const i32x4 -1 1 2 3))
    (local.set $ones (v128.const f32x4 1 1 1 1))
    ;; stride 6 (one species flag): two rays per step, 48 bytes as three v128 stores (the odd last ray and other strides take the loop below)
    (if (i32.eq (local.get $stride) (i32.const 6)) (then
      (local.set $Lv (f64x2.splat (local.get $L)))
      (local.set $one (f64x2.splat (f64.const 1)))
      (block $pd (loop $pl
        (br_if $pd (i32.gt_s (i32.add (local.get $i) (i32.const 2)) (local.get $nR)))
        (local.set $kk (v128.load64_zero offset=1536 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2)))))
        (local.set $cv (v128.load offset=1024 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3)))))
        (if (local.get $calc) (then
          (local.set $cv (v128.andnot (f64x2.sub (local.get $one) (f64x2.div (local.get $cv) (local.get $Lv)))
            (i64x2.eq (i64x2.extend_low_i32x4_s (local.get $kk)) (v128.const i64x2 0 0))))))
        (local.set $cv (f32x4.demote_f64x2_zero (local.get $cv)))
        (local.set $oa (v128.and (i32x4.eq (i8x16.shuffle 0 1 2 3 0 1 2 3 0 1 2 3 0 1 2 3 (local.get $kk) (local.get $kk)) (local.get $kinds)) (local.get $ones)))
        (local.set $ob (v128.and (i32x4.eq (i8x16.shuffle 4 5 6 7 4 5 6 7 4 5 6 7 4 5 6 7 (local.get $kk) (local.get $kk)) (local.get $kinds)) (local.get $ones)))
        (local.set $ob (i8x16.shuffle 20 21 22 23 4 5 6 7 8 9 10 11 12 13 14 15 (local.get $ob) (local.get $cv)))
        (v128.store (local.get $base) (i8x16.shuffle 16 17 18 19 4 5 6 7 8 9 10 11 12 13 14 15 (local.get $oa) (local.get $cv)))
        (v128.store offset=16 (local.get $base) (i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 (v128.const i64x2 0 0) (local.get $ob)))
        (v128.store offset=32 (local.get $base) (i8x16.shuffle 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 (local.get $ob) (v128.const i64x2 0 0)))
        (local.set $base (i32.add (local.get $base) (i32.const 48)))
        (local.set $i (i32.add (local.get $i) (i32.const 2)))
        (br $pl)))))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $nR)))
      (local.set $kind (i32.load offset=1536 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2)))))
      (local.set $clo (f64.load offset=1024 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3)))))
      (if (local.get $calc) (then
        (if (i32.eqz (local.get $kind)) (then (local.set $clo (f64.const 0)))
          (else (local.set $clo (f64.sub (f64.const 1) (f64.div (local.get $clo) (local.get $L))))))))
      (v128.store (local.get $base) (f32x4.replace_lane 0
        (v128.and (i32x4.eq (i32x4.splat (local.get $kind)) (local.get $kinds)) (local.get $ones))
        (f32.demote_f64 (local.get $clo))))
      (if (i32.eq (local.get $stride) (i32.const 6)) (then (i64.store offset=16 (local.get $base) (i64.const 0)))
        (else (local.set $z (i32.const 16)) (block $zd (loop $zl
          (br_if $zd (i32.gt_s (i32.add (local.get $z) (i32.const 16)) (i32.shl (local.get $stride) (i32.const 2))))
          (v128.store (i32.add (local.get $base) (local.get $z)) (v128.const i64x2 0 0))
          (local.set $z (i32.add (local.get $z) (i32.const 16)))
          (br $zl)))
          (block $zd1 (loop $zl1
          (br_if $zd1 (i32.ge_s (local.get $z) (i32.shl (local.get $stride) (i32.const 2))))
          (i32.store (i32.add (local.get $base) (local.get $z)) (i32.const 0))
          (local.set $z (i32.add (local.get $z) (i32.const 4)))
          (br $zl1)))))
      (local.set $base (i32.add (local.get $base) (i32.shl (local.get $stride) (i32.const 2))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func (export "sense") (param $P i32)
    (local $kinds v128) (local $ones v128) (local $three v128) (local $j i32) (local $n i32) (local $q i32) (local $nR i32) (local $i i32) (local $stride i32)
    (local $x f64) (local $y f64) (local $hc f64) (local $hs f64) (local $L f64) (local $self i32) (local $off i32) (local $inp i32)
    (local $scr i32) (local $cand i32) (local $W f64) (local $H f64) (local $r f64) (local $r2 f64)
    (local $far f64) (local $far2 f64) (local $margin f64) (local $nmargin f64) (local $open i32) (local $openc i32) (local $last i32)
    (local $d0x f64) (local $d0y f64) (local $d1x f64) (local $d1y f64)
    (local $cx0 i32) (local $cx1 i32) (local $cy0 i32) (local $cy1 i32) (local $cx i32) (local $cy i32) (local $c i32)
    (local $it i32) (local $fx f64) (local $fy f64) (local $d2 f64) (local $cp i32) (local $ce i32) (local $inv f64) (local $cols i32) (local $rows i32)
    (local $dx f64) (local $dy f64) (local $best f64) (local $kind i32) (local $tw f64) (local $t f64) (local $b f64) (local $cc f64) (local $disc f64)
    (local $ie i32) (local $cur i32) (local $sp i32) (local $spp i32) (local $det i32) (local $walls i32) (local $clo f64) (local $oc f64) (local $os f64)
    ;; crowd phase
    (local $x32 f32) (local $y32 f32) (local $L32 f32) (local $rc f32) (local $invc f32) (local $r2c f32) (local $farc f32) (local $far2c f32) (local $marginc f32) (local $nmarginc f32)
    (local $d0xf f32) (local $d0yf f32) (local $d1xf f32) (local $d1yf f32) (local $fxf f32) (local $fyf f32) (local $d2f f32)
    (local $k i32) (local $e i32) (local $row i32) (local $g i32) (local $ro i32) (local $sstart i32) (local $sx i32) (local $sy i32) (local $own i32)
    (local $dxv v128) (local $dyv v128) (local $bs v128) (local $ix v128) (local $bv v128) (local $cv v128) (local $discv v128) (local $tv v128) (local $inside v128) (local $m v128)
    (local $mk i32) (local $ng i32) (local $rtv v128) (local $cim i32) (local $cend i32) (local $pass i32) (local $rtk v128) (local $infv v128) (local $sv v128) (local $fxv v128) (local $fyv v128)
    (local $ist i32) (local $ixy i32) (local $ikd i32)
    (local $vt v128) (local $vfx v128) (local $vfy v128) (local $vm1 v128) (local $vx v128) (local $vy v128) (local $vfar2 v128) (local $vopen v128) (local $vd0x v128) (local $vd0y v128) (local $vd1x v128) (local $vd1y v128) (local $vnm v128) (local $vmg v128) (local $bm i32)
    (local $ps i32) (local $base i32) (local $sigp i32) (local $cStart i32) (local $ccols i32) (local $crows i32)
    ;; rock
    (local $rcols i32) (local $rrows i32) (local $rstart i32) (local $rorder i32) (local $rxyr i32) (local $rmax f64) (local $rinv f64)
    (local $rext f64) (local $rr f64) (local $rfar f64) (local $rm f64) (local $di i32) (local $rlb i32) (local $skip i32)
    (local $cc32 f32) (local $ks i32) (local $sb i32) (local $posv v128) (local $fv v128) (local $invv v128) (local $wlo v128) (local $whi v128) (local $w v128) (local $wmin v128) (local $wmaxI v128) (local $wmaxC v128) (local $pv4 v128) (local $ov4 v128) (local $invcv v128) (local $p0 i32) (local $p1 i32) (local $rstep i32) (local $ge i32)
    (local.set $n (i32.load offset={{S_N}} (local.get $P)))
    (local.set $stride (i32.load offset={{S_STRIDE}} (local.get $P)))
    (local.set $cand (i32.load offset={{S_CAND}} (local.get $P)))
    (local.set $scr (i32.load offset={{S_SCRATCH}} (local.get $P)))
    (local.set $W (f64.load offset={{S_WORLD_W}} (local.get $P)))
    (local.set $H (f64.load offset={{S_WORLD_H}} (local.get $P)))
    (local.set $r (f64.load offset={{S_ITEM_R}} (local.get $P)))
    (local.set $r2 (f64.mul (local.get $r) (local.get $r)))
    (local.set $inv (f64.load offset={{S_INV_ITEM_CELL}} (local.get $P)))
    (local.set $cols (i32.load offset={{S_ITEM_COLS}} (local.get $P)))
    (local.set $rows (i32.load offset={{S_ITEM_ROWS}} (local.get $P)))
    (local.set $invc (f32.load offset={{S_INV_CROWD_CELL}} (local.get $P)))
    (local.set $rc (f32.load offset={{S_CROWD_R}} (local.get $P)))
    (local.set $r2c (f32.mul (local.get $rc) (local.get $rc)))
    (local.set $ccols (i32.load offset={{S_CROWD_COLS}} (local.get $P)))
    (local.set $crows (i32.load offset={{S_CROWD_ROWS}} (local.get $P)))
    (local.set $cStart (i32.load offset={{S_CROWD_START}} (local.get $P)))
    (local.set $sx (i32.load offset={{S_SX}} (local.get $P)))
    (local.set $sy (i32.load offset={{S_SY}} (local.get $P)))
    (local.set $own (i32.load offset={{S_OWN}} (local.get $P)))
    (local.set $sigp (i32.load offset={{S_SIG}} (local.get $P)))
    (local.set $spp (i32.load offset={{S_SPECIES}} (local.get $P)))
    (local.set $rmax (f64.load offset={{S_ROCK_MAX_R}} (local.get $P)))
    (local.set $rinv (f64.load offset={{S_INV_ROCK_CELL}} (local.get $P)))
    (local.set $rcols (i32.load offset={{S_ROCK_COLS}} (local.get $P)))
    (local.set $rrows (i32.load offset={{S_ROCK_ROWS}} (local.get $P)))
    (local.set $rstart (i32.load offset={{S_ROCK_START}} (local.get $P)))
    (local.set $rorder (i32.load offset={{S_ROCK_ORDER}} (local.get $P)))
    (local.set $rxyr (i32.load offset={{S_ROCK_XYR}} (local.get $P)))
    (local.set $rlb (i32.load offset={{S_ROCK_LB}} (local.get $P)))
    (local.set $ist (i32.load offset={{S_ITEM_START}} (local.get $P)))
    (local.set $ixy (i32.load offset={{S_ITEM_XY}} (local.get $P)))
    (local.set $ikd (i32.load offset={{S_ITEM_KIND}} (local.get $P)))
    (local.set $wmin (v128.const i32x4 0 0 -2147483648 -2147483648))
    (local.set $wmaxI (i32x4.replace_lane 3 (i32x4.replace_lane 2 (v128.const i32x4 2147483647 2147483647 0 0) (i32.sub (local.get $cols) (i32.const 1))) (i32.sub (local.get $rows) (i32.const 1))))
    (local.set $wmaxC (i32x4.replace_lane 3 (i32x4.replace_lane 2 (v128.const i32x4 2147483647 2147483647 0 0) (i32.sub (local.get $ccols) (i32.const 1))) (i32.sub (local.get $crows) (i32.const 1))))
    (local.set $invv (f64x2.splat (local.get $inv)))
    (local.set $invcv (f32x4.splat (local.get $invc)))
    (block $jd (loop $jl
      (br_if $jd (i32.ge_u (local.get $j) (local.get $n)))
      (block $jn
      (local.set $q (i32.add (i32.load offset={{S_REC}} (local.get $P)) (i32.shl (local.get $j) (i32.const {{REC_SHIFT}}))))
      (local.set $x (f64.load offset={{REC_X}} (local.get $q)))
      (local.set $y (f64.load offset={{REC_Y}} (local.get $q)))
      (local.set $hc (f64.load offset={{REC_COS}} (local.get $q)))
      (local.set $hs (f64.load offset={{REC_SIN}} (local.get $q)))
      (local.set $L (f64.load offset={{REC_RAY_LENGTH}} (local.get $q)))
      (local.set $self (i32.load offset={{REC_SELF}} (local.get $q)))
      (local.set $nR (i32.load offset={{REC_RAYS}} (local.get $q)))
      (local.set $off (i32.load offset={{REC_OFFSETS}} (local.get $q)))
      (local.set $inp (i32.load offset={{REC_INPUT}} (local.get $q)))
      (local.set $det (i32.load offset={{REC_DETAIL}} (local.get $q)))
      (br_if $jn (i32.eqz (local.get $nR)))
      (local.set $walls (i32.or (i32.or
        (f64.lt (local.get $x) (f64.mul (local.get $L) (f64.add (f64.const 1) (f64.const 1e-6))))
        (f64.lt (f64.sub (local.get $W) (local.get $x)) (f64.mul (local.get $L) (f64.add (f64.const 1) (f64.const 1e-6)))))
        (i32.or
        (f64.lt (local.get $y) (f64.mul (local.get $L) (f64.add (f64.const 1) (f64.const 1e-6))))
        (f64.lt (f64.sub (local.get $H) (local.get $y)) (f64.mul (local.get $L) (f64.add (f64.const 1) (f64.const 1e-6)))))))
      ;; the two outer ray directions (as the loop below computes them) bound the wedge for the candidate walks
      (local.set $last (i32.sub (local.get $nR) (i32.const 1)))
      (local.set $oc (f64.load (local.get $off)))
      (local.set $os (f64.load (i32.add (local.get $off) (i32.shl (local.get $nR) (i32.const 3)))))
      (local.set $d0x (f64.sub (f64.mul (local.get $hc) (local.get $oc)) (f64.mul (local.get $hs) (local.get $os))))
      (local.set $d0y (f64.add (f64.mul (local.get $hs) (local.get $oc)) (f64.mul (local.get $hc) (local.get $os))))
      (local.set $oc (f64.load (i32.add (local.get $off) (i32.shl (local.get $last) (i32.const 3)))))
      (local.set $os (f64.load (i32.add (i32.add (local.get $off) (i32.shl (local.get $nR) (i32.const 3))) (i32.shl (local.get $last) (i32.const 3)))))
      (local.set $d1x (f64.sub (f64.mul (local.get $hc) (local.get $oc)) (f64.mul (local.get $hs) (local.get $os))))
      (local.set $d1y (f64.add (f64.mul (local.get $hs) (local.get $oc)) (f64.mul (local.get $hc) (local.get $os))))
      (local.set $open (i32.eqz (i32.and (i32.gt_s (local.get $nR) (i32.const 1))
        (f64.gt (f64.sub (f64.mul (local.get $d0x) (local.get $d1y)) (f64.mul (local.get $d0y) (local.get $d1x))) (f64.const 1e-9)))))
      ;; item candidates, in grid order (the same order the anchored list holds)
      (local.set $far (f64.add (f64.add (local.get $L) (local.get $r)) (f64.mul (f64.const 1e-9) (local.get $L))))
      (local.set $far2 (f64.mul (local.get $far) (local.get $far)))
      (local.set $margin (f64.add (local.get $r) (f64.mul (f64.const 1e-9) (local.get $L))))
      (local.set $nmargin (f64.neg (local.get $margin)))
      ;; the item walk tests two items at a time in f64x2, lane for lane the operations of a scalar test
      (local.set $vx (f64x2.splat (local.get $x)))
      (local.set $vy (f64x2.splat (local.get $y)))
      (local.set $vfar2 (f64x2.splat (local.get $far2)))
      (local.set $vopen (i64x2.splat (i64.extend_i32_s (i32.sub (i32.const 0) (local.get $open)))))
      (local.set $vd0x (f64x2.splat (local.get $d0x)))
      (local.set $vd0y (f64x2.splat (local.get $d0y)))
      (local.set $vd1x (f64x2.splat (local.get $d1x)))
      (local.set $vd1y (f64x2.splat (local.get $d1y)))
      (local.set $vnm (f64x2.splat (local.get $nmargin)))
      (local.set $vmg (f64x2.splat (local.get $margin)))
      ;; the cell window as one vector chain: floor, saturating convert and clamp of the lower corner (>= 0) and the upper corner (<= last cell), the same values as the scalar chain
      (local.set $posv (f64x2.replace_lane 1 (f64x2.splat (local.get $x)) (local.get $y)))
      (local.set $fv (f64x2.splat (local.get $far)))
      (local.set $wlo (i32x4.trunc_sat_f64x2_s_zero (f64x2.floor (f64x2.mul (f64x2.sub (local.get $posv) (local.get $fv)) (local.get $invv)))))
      (local.set $whi (i32x4.trunc_sat_f64x2_s_zero (f64x2.floor (f64x2.mul (f64x2.add (local.get $posv) (local.get $fv)) (local.get $invv)))))
      (local.set $w (i32x4.min_s (i32x4.max_s (i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 (local.get $wlo) (local.get $whi)) (local.get $wmin)) (local.get $wmaxI)))
      (local.set $cx0 (i32x4.extract_lane 0 (local.get $w)))
      (local.set $cy0 (i32x4.extract_lane 1 (local.get $w)))
      (local.set $cx1 (i32x4.extract_lane 2 (local.get $w)))
      (local.set $cy1 (i32x4.extract_lane 3 (local.get $w)))
      ;; a first column past the last (an extreme position) has no cells and must not index the tables
      (if (i32.gt_s (local.get $cx0) (local.get $cx1)) (then (local.set $cy1 (i32.sub (local.get $cy0) (i32.const 1)))))
      (local.set $rstep (i32.shl (i32.add (local.get $cols) (i32.const 1)) (i32.const 2)))
      (local.set $p0 (i32.add (local.get $ist) (i32.shl (i32.add (i32.mul (local.get $cy0) (i32.add (local.get $cols) (i32.const 1))) (local.get $cx0)) (i32.const 2))))
      (local.set $p1 (i32.add (local.get $ist) (i32.shl (i32.add (i32.add (i32.mul (local.get $cy0) (i32.add (local.get $cols) (i32.const 1))) (local.get $cx1)) (i32.const 1)) (i32.const 2))))
      (local.set $cp (local.get $cand))
      (local.set $cy (local.get $cy0))
      (block $cyd (loop $cyl
        (br_if $cyd (i32.gt_s (local.get $cy) (local.get $cy1)))
        ;; the cells cx0..cx1 of a row are one run of the packed items, in cell order and head-insertion order inside a cell
        (local.set $it (i32.load (local.get $p0)))
        (local.set $ie (i32.load (local.get $p1)))
        (local.set $p0 (i32.add (local.get $p0) (local.get $rstep)))
        (local.set $p1 (i32.add (local.get $p1) (local.get $rstep)))
        (block $itd (loop $itl
          (br_if $itd (i32.ge_s (local.get $it) (local.get $ie)))
          ;; the pair at it, it+1 (the last run's odd item reads the 8 bytes after it, which the item region keeps, and its second lane is masked); candidates are written in item order
          (local.set $vt (v128.load (i32.add (local.get $ixy) (i32.shl (local.get $it) (i32.const 3)))))
          (local.set $vfx (f64x2.sub (f64x2.promote_low_f32x4 (i8x16.shuffle 0 1 2 3 8 9 10 11 0 1 2 3 8 9 10 11 (local.get $vt) (local.get $vt))) (local.get $vx)))
          (local.set $vfy (f64x2.sub (f64x2.promote_low_f32x4 (i8x16.shuffle 4 5 6 7 12 13 14 15 4 5 6 7 12 13 14 15 (local.get $vt) (local.get $vt))) (local.get $vy)))
          (local.set $vm1 (f64x2.le (f64x2.add (f64x2.mul (local.get $vfx) (local.get $vfx)) (f64x2.mul (local.get $vfy) (local.get $vfy))) (local.get $vfar2)))
          (local.set $vm1 (v128.and (local.get $vm1) (v128.or (local.get $vopen)
            (v128.and
              (f64x2.ge (f64x2.sub (f64x2.mul (local.get $vd0x) (local.get $vfy)) (f64x2.mul (local.get $vd0y) (local.get $vfx))) (local.get $vnm))
              (f64x2.le (f64x2.sub (f64x2.mul (local.get $vd1x) (local.get $vfy)) (f64x2.mul (local.get $vd1y) (local.get $vfx))) (local.get $vmg))))))
          (local.set $bm (i64x2.bitmask (local.get $vm1)))
          (v128.store (local.get $cp) (i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 (local.get $vfx) (local.get $vfy)))
          (i32.store offset=24 (local.get $cp) (local.get $it))
          (local.set $cp (i32.add (local.get $cp) (i32.shl (i32.and (local.get $bm) (i32.const 1)) (i32.const 5))))
          (v128.store (local.get $cp) (i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31 (local.get $vfx) (local.get $vfy)))
          (i32.store offset=24 (local.get $cp) (i32.add (local.get $it) (i32.const 1)))
          (local.set $cp (i32.add (local.get $cp) (i32.shl (i32.and (i32.shr_u (local.get $bm) (i32.const 1)) (i32.gt_s (i32.sub (local.get $ie) (local.get $it)) (i32.const 1))) (i32.const 5))))
          (local.set $it (i32.add (local.get $it) (i32.const 2)))
          (br $itl)))
        (local.set $cy (i32.add (local.get $cy) (i32.const 1)))
        (br $cyl)))
      (local.set $cim (local.get $cp))  ;; the items end here; the rock discs follow
      ;; rock discs after the items, as wall candidates in grid order; a disc is far past length + radius
      ;; none can be near when the cell holding the creature is farther from every disc edge (rockLowerBound) than the ray length, with a margin far above the rounding
      (local.set $skip (i32.const 0))
      (local.set $cx (i32.trunc_sat_f64_s (f64.floor (f64.mul (local.get $x) (local.get $rinv)))))
      (local.set $cy (i32.trunc_sat_f64_s (f64.floor (f64.mul (local.get $y) (local.get $rinv)))))
      (if (i32.and (i32.lt_u (local.get $cx) (local.get $rcols)) (i32.lt_u (local.get $cy) (local.get $rrows))) (then
        (local.set $skip (f64.gt (f64.promote_f32 (f32.load (i32.add (local.get $rlb) (i32.shl (i32.add (i32.mul (local.get $cy) (local.get $rcols)) (local.get $cx)) (i32.const 2)))))
          (f64.add (f64.mul (local.get $L) (f64.const 1.000001)) (f64.const 0.001))))))
      (if (i32.and (i32.gt_s (local.get $rcols) (i32.const 0)) (i32.eqz (local.get $skip))) (then
        (local.set $rext (f64.add (f64.mul (local.get $L) (f64.add (f64.const 1) (f64.const 1e-9))) (local.get $rmax)))
        (local.set $cx0 (i32.trunc_sat_f64_s (f64.floor (f64.mul (f64.sub (local.get $x) (local.get $rext)) (local.get $rinv)))))
        (local.set $cx0 (select (i32.const 0) (local.get $cx0) (i32.lt_s (local.get $cx0) (i32.const 0))))
        (local.set $cx1 (i32.trunc_sat_f64_s (f64.floor (f64.mul (f64.add (local.get $x) (local.get $rext)) (local.get $rinv)))))
        (local.set $cx1 (select (i32.sub (local.get $rcols) (i32.const 1)) (local.get $cx1) (i32.ge_s (local.get $cx1) (local.get $rcols))))
        (local.set $cy0 (i32.trunc_sat_f64_s (f64.floor (f64.mul (f64.sub (local.get $y) (local.get $rext)) (local.get $rinv)))))
        (local.set $cy0 (select (i32.const 0) (local.get $cy0) (i32.lt_s (local.get $cy0) (i32.const 0))))
        (local.set $cy1 (i32.trunc_sat_f64_s (f64.floor (f64.mul (f64.add (local.get $y) (local.get $rext)) (local.get $rinv)))))
        (local.set $cy1 (select (i32.sub (local.get $rrows) (i32.const 1)) (local.get $cy1) (i32.ge_s (local.get $cy1) (local.get $rrows))))
        (if (i32.gt_s (local.get $cx0) (local.get $cx1)) (then (local.set $cy1 (i32.sub (local.get $cy0) (i32.const 1)))))
        (local.set $cy (local.get $cy0))
        (block $rcyd (loop $rcyl
          (br_if $rcyd (i32.gt_s (local.get $cy) (local.get $cy1)))
          (local.set $ro (i32.mul (local.get $cy) (local.get $rcols)))
          (local.set $it (i32.load (i32.add (local.get $rstart) (i32.shl (i32.add (local.get $ro) (local.get $cx0)) (i32.const 2)))))
          (local.set $ie (i32.load (i32.add (local.get $rstart) (i32.shl (i32.add (i32.add (local.get $ro) (local.get $cx1)) (i32.const 1)) (i32.const 2)))))
          (block $ritd (loop $ritl
            (br_if $ritd (i32.ge_s (local.get $it) (local.get $ie)))
            (local.set $di (i32.add (local.get $rxyr) (i32.mul (i32.load (i32.add (local.get $rorder) (i32.shl (local.get $it) (i32.const 2)))) (i32.const 24))))
            (local.set $fx (f64.sub (f64.load (local.get $di)) (local.get $x)))
            (local.set $fy (f64.sub (f64.load offset=8 (local.get $di)) (local.get $y)))
            (local.set $rr (f64.load offset=16 (local.get $di)))
            (local.set $d2 (f64.add (f64.mul (local.get $fx) (local.get $fx)) (f64.mul (local.get $fy) (local.get $fy))))
            (local.set $rfar (f64.add (f64.add (local.get $L) (local.get $rr)) (f64.mul (f64.const 1e-9) (local.get $L))))
            ;; kept only inside the distance and the ray wedge widened by the disc radius, as the items are; a disc outside it cannot be hit and must not force the busy path
            (if (f64.le (local.get $d2) (f64.mul (local.get $rfar) (local.get $rfar))) (then
              (local.set $rm (f64.add (local.get $rr) (f64.mul (f64.const 1e-9) (local.get $L))))
              (if (i32.or (local.get $open) (i32.and
                  (f64.ge (f64.sub (f64.mul (local.get $d0x) (local.get $fy)) (f64.mul (local.get $d0y) (local.get $fx))) (f64.neg (local.get $rm)))
                  (f64.le (f64.sub (f64.mul (local.get $d1x) (local.get $fy)) (f64.mul (local.get $d1y) (local.get $fx))) (local.get $rm)))) (then
                (f64.store (local.get $cp) (local.get $fx))
                (f64.store offset=8 (local.get $cp) (local.get $fy))
                (f64.store offset=16 (local.get $cp) (f64.sub (local.get $d2) (f64.mul (local.get $rr) (local.get $rr))))
                (local.set $cp (i32.add (local.get $cp) (i32.const 32)))))))
            (local.set $it (i32.add (local.get $it) (i32.const 1)))
            (br $ritl)))
          (local.set $cy (i32.add (local.get $cy) (i32.const 1)))
          (br $rcyl)))))
      (local.set $ce (local.get $cp))
      ;; the f32 crowd window, shared by the early-out walk and the crowd rays
      (local.set $x32 (f32.demote_f64 (local.get $x)))
      (local.set $y32 (f32.demote_f64 (local.get $y)))
      (local.set $L32 (f32.demote_f64 (local.get $L)))
      (local.set $d0xf (f32.demote_f64 (local.get $d0x)))
      (local.set $d0yf (f32.demote_f64 (local.get $d0y)))
      (local.set $d1xf (f32.demote_f64 (local.get $d1x)))
      (local.set $d1yf (f32.demote_f64 (local.get $d1y)))
      (local.set $farc (f32.add (f32.add (local.get $L32) (local.get $rc)) (f32.mul (local.get $L32) (f32.const 1e-9))))
      (local.set $far2c (f32.mul (local.get $farc) (local.get $farc)))
      (local.set $marginc (f32.add (local.get $rc) (f32.mul (local.get $L32) (f32.const 1e-9))))
      (local.set $nmarginc (f32.neg (local.get $marginc)))
      (local.set $openc (i32.eqz (i32.and (i32.gt_s (local.get $nR) (i32.const 1))
        (f32.gt (f32.sub (f32.mul (local.get $d0xf) (local.get $d1yf)) (f32.mul (local.get $d0yf) (local.get $d1xf))) (f32.const 1e-9)))))
      ;; the same for the f32 crowd window
      (local.set $pv4 (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1 (f32x4.splat (local.get $x32)) (local.get $y32)) (local.get $x32)) (local.get $y32)))
      (local.set $ov4 (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.splat (f32.neg (local.get $farc))) (local.get $farc)) (local.get $farc)))
      (local.set $w (i32x4.min_s (i32x4.max_s (i32x4.trunc_sat_f32x4_s (f32x4.floor (f32x4.mul (f32x4.add (local.get $pv4) (local.get $ov4)) (local.get $invcv)))) (local.get $wmin)) (local.get $wmaxC)))
      (local.set $cx0 (i32x4.extract_lane 0 (local.get $w)))
      (local.set $cy0 (i32x4.extract_lane 1 (local.get $w)))
      (local.set $cx1 (i32x4.extract_lane 2 (local.get $w)))
      (local.set $cy1 (i32x4.extract_lane 3 (local.get $w)))
      (if (i32.gt_s (local.get $cx0) (local.get $cx1)) (then (local.set $cy1 (i32.sub (local.get $cy0) (i32.const 1)))))
      ;; early-out: nothing in sight (no item, rock disc or creature candidate, no wall in range, no detail record) means every ray reads "nothing", all features 0
      (block $busy
        (br_if $busy (i32.or (i32.ne (local.get $ce) (local.get $cand)) (i32.or (local.get $walls) (local.get $det))))
        ;; the crowd walk of the creature phase below without its writes: any other creature inside the distance and wedge
        (local.set $mk (i32.const 0))
        (local.set $cy (local.get $cy0))
        (block $ecyd (loop $ecyl
          (br_if $ecyd (i32.gt_s (local.get $cy) (local.get $cy1)))
          (local.set $row (i32.mul (local.get $cy) (local.get $ccols)))
          (local.set $k (i32.load (i32.add (local.get $cStart) (i32.shl (i32.add (local.get $row) (local.get $cx0)) (i32.const 2)))))
          (local.set $e (i32.load (i32.add (local.get $cStart) (i32.shl (i32.add (i32.add (local.get $row) (local.get $cx1)) (i32.const 1)) (i32.const 2)))))
          (block $ekd (loop $ekl
            (br_if $ekd (i32.ge_s (local.get $k) (local.get $e)))
            (local.set $fxf (f32.sub (f32.load (i32.add (local.get $sx) (i32.shl (local.get $k) (i32.const 2)))) (local.get $x32)))
            (local.set $fyf (f32.sub (f32.load (i32.add (local.get $sy) (i32.shl (local.get $k) (i32.const 2)))) (local.get $y32)))
            (local.set $mk (i32.or (local.get $mk) (i32.and (i32.and
              (i32.ne (i32.load (i32.add (local.get $own) (i32.shl (local.get $k) (i32.const 2)))) (local.get $self))
              (f32.le (f32.add (f32.mul (local.get $fxf) (local.get $fxf)) (f32.mul (local.get $fyf) (local.get $fyf))) (local.get $far2c)))
              (i32.or (local.get $openc)
                (i32.and
                  (f32.ge (f32.sub (f32.mul (local.get $d0xf) (local.get $fyf)) (f32.mul (local.get $d0yf) (local.get $fxf))) (local.get $nmarginc))
                  (f32.le (f32.sub (f32.mul (local.get $d1xf) (local.get $fyf)) (f32.mul (local.get $d1yf) (local.get $fxf))) (local.get $marginc)))))))
            (local.set $k (i32.add (local.get $k) (i32.const 1)))
            (br $ekl)))
          (local.set $cy (i32.add (local.get $cy) (i32.const 1)))
          (br $ecyl)))
        (br_if $busy (local.get $mk))
        (local.set $e (i32.mul (local.get $nR) (i32.shl (local.get $stride) (i32.const 2))))
        (local.set $i (i32.const 16))
        (block $zd0 (loop $zl0 (br_if $zd0 (i32.gt_s (local.get $i) (local.get $e)))
          (v128.store (i32.add (local.get $inp) (i32.sub (local.get $i) (i32.const 16))) (v128.const i64x2 0 0))
          (local.set $i (i32.add (local.get $i) (i32.const 16))) (br $zl0)))
        (local.set $i (i32.sub (local.get $i) (i32.const 16)))
        (block $zd1 (loop $zl1 (br_if $zd1 (i32.ge_s (local.get $i) (local.get $e)))
          (i32.store (i32.add (local.get $inp) (local.get $i)) (i32.const 0))
          (local.set $i (i32.add (local.get $i) (i32.const 4))) (br $zl1)))
        (br $jn))
      ;; directions by angle addition
      (local.set $i (call $dirsPairs (local.get $scr) (local.get $off) (local.get $nR) (local.get $hc) (local.get $hs) (i32.eqz (local.get $walls)) (local.get $L)))
      (block $dd (loop $dl
        (br_if $dd (i32.ge_s (local.get $i) (local.get $nR)))
        (local.set $oc (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
        (local.set $os (f64.load (i32.add (i32.add (local.get $off) (i32.shl (local.get $nR) (i32.const 3))) (i32.shl (local.get $i) (i32.const 3)))))
        (f64.store (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3)))
          (f64.sub (f64.mul (local.get $hc) (local.get $oc)) (f64.mul (local.get $hs) (local.get $os))))
        (f64.store offset=512 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3)))
          (f64.add (f64.mul (local.get $hs) (local.get $oc)) (f64.mul (local.get $hc) (local.get $os))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $dl)))
      ;; pad the unused lane of the last pair
      (if (i32.and (local.get $nR) (i32.const 1)) (then (f64.store (i32.add (local.get $scr) (i32.shl (local.get $nR) (i32.const 3))) (f64.const nan)) (f64.store offset=512 (i32.add (local.get $scr) (i32.shl (local.get $nR) (i32.const 3))) (f64.const nan))))
      ;; trace each ray: wall, then candidates
      (local.set $i (i32.const 0))
      (if (i32.eqz (local.get $walls)) (then (local.set $i (i32.and (local.get $nR) (i32.const -2)))))
      (block $rd (loop $rl
        (br_if $rd (i32.ge_s (local.get $i) (local.get $nR)))
        (local.set $dx (f64.load (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3)))))
        (local.set $dy (f64.load offset=512 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3)))))
        (local.set $best (local.get $L))
        (local.set $kind (i32.const 0))
        (local.set $tw (f64.const inf))
        (if (local.get $walls) (then
        (if (f64.gt (local.get $dx) (f64.const 0)) (then (local.set $tw (f64.div (f64.sub (local.get $W) (local.get $x)) (local.get $dx))))
          (else (if (f64.lt (local.get $dx) (f64.const 0)) (then (local.set $tw (f64.div (f64.neg (local.get $x)) (local.get $dx)))))))
        (if (f64.gt (local.get $dy) (f64.const 0)) (then
            (local.set $t (f64.div (f64.sub (local.get $H) (local.get $y)) (local.get $dy)))
            (if (f64.lt (local.get $t) (local.get $tw)) (then (local.set $tw (local.get $t)))))
          (else (if (f64.lt (local.get $dy) (f64.const 0)) (then
            (local.set $t (f64.div (f64.neg (local.get $y)) (local.get $dy)))
            (if (f64.lt (local.get $t) (local.get $tw)) (then (local.set $tw (local.get $t))))))))
        (if (f64.lt (local.get $tw) (f64.const 0)) (then (local.set $tw (f64.const 0))))
        (if (f64.lt (local.get $tw) (local.get $best)) (then (local.set $best (local.get $tw)) (local.set $kind (i32.const 3))))))
        (f64.store offset=1024 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3))) (local.get $best))
        (i32.store offset=1536 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2))) (local.get $kind))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rl)))
      ;; candidates in order, each tested only against the rays it can touch. A ray at distance s from the centre misses unless s^2 <= r^2 (plus a relative margin far above the rounding of
      ;; the exact test below), so the exact test runs on the few rays that pass this cheap two-ray check. Per ray the candidates still arrive in the same order.
      (local.set $rtv (f64x2.splat (f64.add (f64.mul (local.get $r) (local.get $r)) (f64.mul (f64.const 1e-9) (f64.mul (f64.add (local.get $L) (f64.abs (local.get $r))) (f64.add (local.get $L) (f64.abs (local.get $r))))))))
      (local.set $infv (f64x2.splat (f64.const inf)))
      (local.set $ng (i32.shr_u (i32.add (local.get $nR) (i32.const 1)) (i32.const 1)))
      (local.set $ge (i32.add (local.get $scr) (i32.shl (local.get $ng) (i32.const 4))))
      ;; two passes in candidate order: the items with the cheap check, then the rock discs (each with its own radius, not the item's), straight to the exact test
      (local.set $three (v128.const i64x2 3 3))
      (local.set $pass (i32.const 0))
      (block $pdone (loop $ploop
      (br_if $pdone (i32.gt_u (local.get $pass) (i32.const 1)))
      (local.set $cp (select (local.get $cim) (local.get $cand) (local.get $pass)))
      (local.set $cend (select (local.get $ce) (local.get $cim) (local.get $pass)))
      (local.set $rtk (select (result v128) (local.get $infv) (local.get $rtv) (local.get $pass)))
      (block $cd (loop $cl
        (br_if $cd (i32.ge_u (local.get $cp) (local.get $cend)))
        (local.set $fxv (v128.load64_splat (local.get $cp)))
        (local.set $fyv (v128.load64_splat offset=8 (local.get $cp)))
        (local.set $ro (local.get $scr))
        (local.set $sp (local.get $scr))
        (block $gd3 (loop $gl3
          (br_if $gd3 (i32.ge_u (local.get $ro) (local.get $ge)))
          (local.set $dxv (v128.load (local.get $ro)))
          (local.set $dyv (v128.load offset=512 (local.get $ro)))
          (local.set $sv (f64x2.sub (f64x2.mul (local.get $fxv) (local.get $dyv)) (f64x2.mul (local.get $fyv) (local.get $dxv))))
          (local.set $m (f64x2.le (f64x2.mul (local.get $sv) (local.get $sv)) (local.get $rtk)))
          (if (v128.any_true (local.get $m)) (then
            (local.set $bv (f64x2.add (f64x2.mul (local.get $fxv) (local.get $dxv)) (f64x2.mul (local.get $fyv) (local.get $dyv))))
            ;; item candidates carry fx, fy and the index (d2 - r2 is computed here), rock discs carry their own d2 - r^2
            (local.set $cv (if (result v128) (local.get $pass) (then (v128.load64_splat offset=16 (local.get $cp)))
              (else (f64x2.sub (f64x2.add (f64x2.mul (local.get $fxv) (local.get $fxv)) (f64x2.mul (local.get $fyv) (local.get $fyv))) (f64x2.splat (local.get $r2))))))
            (local.set $discv (f64x2.sub (f64x2.mul (local.get $bv) (local.get $bv)) (local.get $cv)))
            (local.set $inside (f64x2.lt (local.get $cv) (v128.const f64x2 0 0)))
            (local.set $tv (v128.andnot (f64x2.sub (local.get $bv) (f64x2.sqrt (f64x2.max (local.get $discv) (v128.const f64x2 0 0)))) (local.get $inside)))
            (local.set $bs (v128.load offset=1024 (local.get $ro)))
            (local.set $ix (i64x2.extend_low_i32x4_s (v128.load64_zero offset=1536 (local.get $sp))))
            (local.set $m (v128.and (v128.and (local.get $m)
              (v128.or (local.get $inside) (v128.and (f64x2.gt (local.get $bv) (v128.const f64x2 0 0)) (f64x2.ge (local.get $discv) (v128.const f64x2 0 0)))))
              (v128.or (f64x2.lt (local.get $tv) (local.get $bs))
                (v128.and (f64x2.eq (local.get $tv) (local.get $bs)) (i64x2.eq (local.get $ix) (local.get $three))))))
            (if (v128.any_true (local.get $m)) (then
              (local.set $ks (if (result i32) (local.get $pass) (then (i32.const 3))
                (else (select (i32.const 1) (i32.const 2) (i32.eq (i32.load8_u (i32.add (local.get $ikd) (i32.load offset=24 (local.get $cp)))) (i32.const 1))))))
              (v128.store offset=1024 (local.get $ro) (v128.bitselect (local.get $tv) (local.get $bs) (local.get $m)))
              (v128.store64_lane offset=1536 0 (local.get $sp)
                (v128.bitselect (i32x4.splat (local.get $ks)) (v128.load64_zero offset=1536 (local.get $sp))
                  (i8x16.shuffle 0 1 2 3 8 9 10 11 0 1 2 3 8 9 10 11 (local.get $m) (local.get $m))))))
          ))
          (local.set $ro (i32.add (local.get $ro) (i32.const 16)))
          (local.set $sp (i32.add (local.get $sp) (i32.const 8)))
          (br $gl3)))
        (local.set $cp (i32.add (local.get $cp) (i32.const 32)))
        (br $cl)))
      (local.set $pass (i32.add (local.get $pass) (i32.const 1)))
      (br $ploop)))
      ;; crowd rays (f32), over the window computed above
      (local.set $cp (local.get $cand))
      (local.set $cy (local.get $cy0))
      (block $cyd2 (loop $cyl2
        (br_if $cyd2 (i32.gt_s (local.get $cy) (local.get $cy1)))
        (local.set $row (i32.mul (local.get $cy) (local.get $ccols)))
        (local.set $k (i32.load (i32.add (local.get $cStart) (i32.shl (i32.add (local.get $row) (local.get $cx0)) (i32.const 2)))))
        (local.set $e (i32.load (i32.add (local.get $cStart) (i32.shl (i32.add (i32.add (local.get $row) (local.get $cx1)) (i32.const 1)) (i32.const 2)))))
        (block $kd (loop $kl
          (br_if $kd (i32.ge_s (local.get $k) (local.get $e)))
          (local.set $fxf (f32.sub (f32.load (i32.add (local.get $sx) (i32.shl (local.get $k) (i32.const 2)))) (local.get $x32)))
          (local.set $fyf (f32.sub (f32.load (i32.add (local.get $sy) (i32.shl (local.get $k) (i32.const 2)))) (local.get $y32)))
          (local.set $d2f (f32.add (f32.mul (local.get $fxf) (local.get $fxf)) (f32.mul (local.get $fyf) (local.get $fyf))))
          ;; branch-free as the item walk: write the candidate, advance only when it is another creature inside the distance and wedge
          (f32.store (local.get $cp) (local.get $fxf))
          (f32.store offset=4 (local.get $cp) (local.get $fyf))
          (f32.store offset=8 (local.get $cp) (f32.sub (local.get $d2f) (local.get $r2c)))
          (i32.store offset=12 (local.get $cp) (local.get $k))
          (local.set $cp (i32.add (local.get $cp)
            (i32.shl (i32.and (i32.and
              (i32.ne (i32.load (i32.add (local.get $own) (i32.shl (local.get $k) (i32.const 2)))) (local.get $self))
              (f32.le (local.get $d2f) (local.get $far2c)))
              (i32.or (local.get $openc)
                (i32.and
                  (f32.ge (f32.sub (f32.mul (local.get $d0xf) (local.get $fyf)) (f32.mul (local.get $d0yf) (local.get $fxf))) (local.get $nmarginc))
                  (f32.le (f32.sub (f32.mul (local.get $d1xf) (local.get $fyf)) (f32.mul (local.get $d1yf) (local.get $fxf))) (local.get $marginc))))) (i32.const 4))))
          (local.set $k (i32.add (local.get $k) (i32.const 1)))
          (br $kl)))
        (local.set $cy (i32.add (local.get $cy) (i32.const 1)))
        (br $cyl2)))
      (local.set $ce (local.get $cp))
      ;; no creature candidate and no detail record: no ray can see a creature, so the features are closeness, the one-hot and zeros
      (if (i32.and (i32.eq (local.get $ce) (local.get $cand)) (i32.eqz (local.get $det))) (then
        (call $emit (local.get $scr) (local.get $inp) (local.get $nR) (local.get $stride) (local.get $L) (i32.const 1))
        (br $jn)))
      ;; closeness, and the crowd rays' inputs
      (local.set $i (call $closePairs (local.get $scr) (local.get $L) (local.get $nR)))
      (block $rd2 (loop $rl2
        (br_if $rd2 (i32.ge_s (local.get $i) (local.get $nR)))
        (local.set $best (f64.load offset=1024 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3)))))
        (local.set $kind (i32.load offset=1536 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2)))))
        (if (i32.eqz (local.get $kind)) (then (local.set $clo (f64.const 0))) (else (local.set $clo (f64.sub (f64.const 1) (f64.div (local.get $best) (local.get $L))))))
        (f64.store offset=1024 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3))) (local.get $clo))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rl2)))
      (call $crowdPrep (local.get $scr) (local.get $L) (local.get $nR))
      (local.set $g (i32.const 0))
      (block $gd (loop $gl
        (br_if $gd (i32.ge_s (i32.shl (local.get $g) (i32.const 2)) (local.get $nR)))
        (local.set $ro (i32.shl (local.get $g) (i32.const 4)))
        (local.set $dxv (v128.load offset=1792 (i32.add (local.get $scr) (local.get $ro))))
        (local.set $dyv (v128.load offset=2048 (i32.add (local.get $scr) (local.get $ro))))
        (local.set $bs (v128.load offset=2304 (i32.add (local.get $scr) (local.get $ro))))
        (local.set $ix (v128.const i32x4 -1 -1 -1 -1))
        (local.set $cp (local.get $cand))
        (block $cd2 (loop $cl2
          (br_if $cd2 (i32.ge_u (local.get $cp) (local.get $ce)))
          (local.set $bv (f32x4.add (f32x4.mul (v128.load32_splat (local.get $cp)) (local.get $dxv))
                                    (f32x4.mul (v128.load32_splat offset=4 (local.get $cp)) (local.get $dyv))))
          (local.set $cv (v128.load32_splat offset=8 (local.get $cp)))
          (local.set $discv (f32x4.sub (f32x4.mul (local.get $bv) (local.get $bv)) (local.get $cv)))
          (local.set $tv (f32x4.sub (local.get $bv) (f32x4.sqrt (f32x4.max (local.get $discv) (v128.const f32x4 0 0 0 0)))))
          (local.set $inside (f32x4.lt (local.get $cv) (v128.const f32x4 0 0 0 0)))
          (local.set $tv (v128.andnot (local.get $tv) (local.get $inside)))
          (local.set $m (v128.and
            (v128.or (local.get $inside) (v128.and (f32x4.gt (local.get $bv) (v128.const f32x4 0 0 0 0)) (f32x4.ge (local.get $discv) (v128.const f32x4 0 0 0 0))))
            (f32x4.lt (local.get $tv) (local.get $bs))))
          (local.set $bs (v128.bitselect (local.get $tv) (local.get $bs) (local.get $m)))
          (local.set $ix (v128.bitselect (v128.load32_splat offset=12 (local.get $cp)) (local.get $ix) (local.get $m)))
          (local.set $cp (i32.add (local.get $cp) (i32.const 16)))
          (br $cl2)))
        (v128.store offset=2304 (i32.add (local.get $scr) (local.get $ro)) (local.get $bs))
        (v128.store offset=2560 (i32.add (local.get $scr) (local.get $ro)) (local.get $ix))
        (local.set $g (i32.add (local.get $g) (i32.const 1)))
        (br $gl)))
      ;; merge the crowd hits and write the features
      (local.set $i (i32.const 0))
      (local.set $sb (i32.shl (local.get $stride) (i32.const 2)))
      (local.set $base (local.get $inp))
      ;; no creature seen and no detail record: every ray's features are closeness, the one-hot and zeros
      (if (i32.eqz (local.get $det)) (then (if (call $unseen (local.get $scr) (local.get $nR))
        (then (call $emit (local.get $scr) (local.get $base) (local.get $nR) (local.get $stride) (local.get $L) (i32.const 0)) (local.set $i (local.get $nR))))))
      (local.set $kinds (v128.const i32x4 -1 1 2 3))
      (local.set $ones (v128.const f32x4 1 1 1 1))
      ;; no detail record and stride 6: the same features as the loop below, with the seen-creature branch instead of selects
      (if (i32.and (i32.eqz (local.get $det)) (i32.eq (local.get $stride) (i32.const 6))) (then
        (block $ld (loop $ll
          (br_if $ld (i32.ge_s (local.get $i) (local.get $nR)))
          (local.set $ps (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2))))
          (local.set $k (i32.load offset=2560 (local.get $ps)))
          (if (i32.ge_s (local.get $k) (i32.const 0)) (then
            (v128.store (local.get $base) (f32x4.replace_lane 0 (v128.const i64x2 0 0)
              (f32.demote_f64 (f64.sub (f64.const 1) (f64.div (f64.promote_f32 (f32.load offset=2304 (local.get $ps))) (f64.promote_f32 (local.get $L32)))))))
            (f32.store offset=16 (local.get $base) (f32.convert_i32_u (i32.eqz (i32.load (i32.add (local.get $spp) (i32.shl (local.get $k) (i32.const 2)))))))
            (f32.store offset=20 (local.get $base) (f32.load (i32.add (local.get $sigp) (i32.shl (local.get $k) (i32.const 2))))))
          (else
            (v128.store (local.get $base) (f32x4.replace_lane 0
              (v128.and (i32x4.eq (i32x4.splat (i32.load offset=1536 (local.get $ps))) (local.get $kinds)) (local.get $ones))
              (f32.demote_f64 (f64.load offset=1024 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3)))))))
            (i64.store offset=16 (local.get $base) (i64.const 0))))
          (local.set $base (i32.add (local.get $base) (i32.const 24)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $ll)))))
      (block $wd (loop $wl
        (br_if $wd (i32.ge_s (local.get $i) (local.get $nR)))
        (local.set $ps (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 2))))
        (local.set $kind (i32.load offset=1536 (local.get $ps)))
        (local.set $clo (f64.load offset=1024 (i32.add (local.get $scr) (i32.shl (local.get $i) (i32.const 3)))))
        (local.set $k (i32.load offset=2560 (local.get $ps)))
        (if (i32.ge_s (local.get $k) (i32.const 0)) (then
          (local.set $clo (f64.sub (f64.const 1) (f64.div (f64.promote_f32 (f32.load offset=2304 (local.get $ps))) (f64.promote_f32 (local.get $L32)))))
          (local.set $kind (i32.const 4))))
        (if (local.get $det) (then
          (f64.store (i32.add (local.get $det) (i32.shl (local.get $i) (i32.const 4))) (local.get $clo))
          (i32.store offset=8 (i32.add (local.get $det) (i32.shl (local.get $i) (i32.const 4))) (local.get $kind))
          (i32.store offset=12 (i32.add (local.get $det) (i32.shl (local.get $i) (i32.const 4))) (local.get $k))))
        ;; Crowd feature extension point: the seen creature is crowd slot $k (-1 for none); per-slot tables like sig are indexed by it here.
        ;; closeness, then the one-hot of food, poison and wall (kind 1 to 3) in one store
        (v128.store (local.get $base)
          (f32x4.replace_lane 0
            (v128.and (i32x4.eq (i32x4.splat (local.get $kind)) (local.get $kinds)) (local.get $ones))
            (f32.demote_f64 (local.get $clo))))
        ;; creature features: one flag per species at offset 16 (S = stride - 5), then the squashed seen energy; no branch on the seen creature, slot 0 stands in for none
        (local.set $ks (select (local.get $k) (i32.const 0) (i32.ge_s (local.get $k) (i32.const 0))))
        (local.set $cc32 (select (f32.load (i32.add (local.get $sigp) (i32.shl (local.get $ks) (i32.const 2)))) (f32.const 0) (i32.ge_s (local.get $k) (i32.const 0))))
        (if (i32.eq (local.get $stride) (i32.const 6)) (then
          (f32.store offset=16 (local.get $base)
            (f32.convert_i32_u (i32.and (i32.ge_s (local.get $k) (i32.const 0)) (i32.eqz (i32.load (i32.add (local.get $spp) (i32.shl (local.get $ks) (i32.const 2))))))))
          (f32.store offset=20 (local.get $base) (local.get $cc32)))
        (else (if (i32.gt_s (local.get $stride) (i32.const 4)) (then
          (local.set $sp (select (i32.load (i32.add (local.get $spp) (i32.shl (local.get $ks) (i32.const 2)))) (i32.const -1) (i32.ge_s (local.get $k) (i32.const 0))))
          (local.set $g (i32.const 0))
          (block $sd (loop $sl
            (br_if $sd (i32.ge_s (local.get $g) (i32.sub (local.get $stride) (i32.const 5))))
            (f32.store offset=16 (i32.add (local.get $base) (i32.shl (local.get $g) (i32.const 2)))
              (select (f32x4.extract_lane 0 (local.get $ones)) (f32.const 0) (i32.eq (local.get $sp) (local.get $g))))
            (local.set $g (i32.add (local.get $g) (i32.const 1)))
            (br $sl)))
          (f32.store offset=16 (i32.add (local.get $base) (i32.shl (i32.sub (local.get $stride) (i32.const 5)) (i32.const 2))) (local.get $cc32))))))
        (local.set $base (i32.add (local.get $base) (local.get $sb)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $wl)))
      )
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $jl))))

  ;; $patchItems: resizes the packed item cells of n records (i32 x4: byte address of the cell's itemStart entry, byte address of its row's last entry, the cell's new item count, the row run's end slot),
  ;; in order, the way a JS patch does: the rest of the row moves by the change in length in the xy (f32 pairs), kind (u8) and id (i32) arrays and the later start entries shift.
  ;; Returns the number of records done; fewer than n means the row outgrew its run (the caller rebuilds everything). The new cells' items are written by the caller.
  (func (export "patchItems") (param $rec i32) (param $n i32) (param $xy i32) (param $kd i32) (param $ids i32) (result i32)
    (local $i i32) (local $sA i32) (local $lastA i32) (local $at i32) (local $nx i32) (local $end i32) (local $delta i32) (local $mv i32) (local $dst i32) (local $p i32) (local $dv v128)
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $sA (i32.load (local.get $rec)))
      (local.set $lastA (i32.load offset=4 (local.get $rec)))
      (local.set $at (i32.load (local.get $sA)))
      (local.set $nx (i32.load offset=4 (local.get $sA)))
      (local.set $delta (i32.sub (i32.add (local.get $at) (i32.load offset=8 (local.get $rec))) (local.get $nx)))
      (if (i32.ne (local.get $delta) (i32.const 0)) (then
        (local.set $end (i32.load (local.get $lastA)))
        (br_if $done (i32.gt_s (i32.add (local.get $end) (local.get $delta)) (i32.load offset=12 (local.get $rec))))
        (local.set $mv (i32.sub (local.get $end) (local.get $nx)))
        (local.set $dst (i32.add (local.get $nx) (local.get $delta)))
        (memory.copy (i32.add (local.get $xy) (i32.shl (local.get $dst) (i32.const 3))) (i32.add (local.get $xy) (i32.shl (local.get $nx) (i32.const 3))) (i32.shl (local.get $mv) (i32.const 3)))
        (memory.copy (i32.add (local.get $kd) (local.get $dst)) (i32.add (local.get $kd) (local.get $nx)) (local.get $mv))
        (memory.copy (i32.add (local.get $ids) (i32.shl (local.get $dst) (i32.const 2))) (i32.add (local.get $ids) (i32.shl (local.get $nx) (i32.const 2))) (i32.shl (local.get $mv) (i32.const 2)))
        (local.set $dv (i32x4.splat (local.get $delta)))
        (local.set $p (i32.add (local.get $sA) (i32.const 4)))
        (block $vd (loop $vl
          (br_if $vd (i32.gt_u (i32.add (local.get $p) (i32.const 16)) (i32.add (local.get $lastA) (i32.const 4))))
          (v128.store (local.get $p) (i32x4.add (v128.load (local.get $p)) (local.get $dv)))
          (local.set $p (i32.add (local.get $p) (i32.const 16)))
          (br $vl)))
        (block $sd (loop $sl
          (br_if $sd (i32.gt_u (local.get $p) (local.get $lastA)))
          (i32.store (local.get $p) (i32.add (i32.load (local.get $p)) (local.get $delta)))
          (local.set $p (i32.add (local.get $p) (i32.const 4)))
          (br $sl)))))
      (local.set $rec (i32.add (local.get $rec) (i32.const 16)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (local.get $i))
)
