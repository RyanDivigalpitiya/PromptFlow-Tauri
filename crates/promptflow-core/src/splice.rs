//! Carrying style runs across a text edit.
//!
//! Every edit to a node's text is ONE splice: a range `[location, location+length)` of
//! the old text is replaced by `replacement_length` new UTF-16 units. Marks are carried
//! across it; characters inserted strictly INSIDE a run inherit that run.
//!
//! This is the canonical statement of a rule that has to exist in three languages:
//!   * TypeScript — `adjustRangesForEdit` in `src/lib/bold.ts`, which derives the same
//!     splice from a before/after string diff (a contenteditable hands it no range);
//!   * Swift — `RangeSplice.apply(ranges:edit:replacementLength:)`, which takes the
//!     range straight from `textView(_:shouldChangeTextIn:replacementText:)`;
//!   * here, which generates `fixtures/splice_vectors.json` for both to be pinned by.
//!
//! Offsets are UTF-16 code units end to end, never bytes.

/// Expand flat `[location, length, …]` pairs into a per-character mark array.
fn to_marks(ranges: &[i64], len: i64) -> Vec<bool> {
    let mut marks = vec![false; len.max(0) as usize];
    for pair in ranges.chunks(2) {
        if pair.len() < 2 {
            break;
        }
        let lo = pair[0].clamp(0, len);
        let hi = (pair[0] + pair[1]).clamp(lo, len);
        for m in &mut marks[lo as usize..hi as usize] {
            *m = true;
        }
    }
    marks
}

/// Collapse a mark array back into flat `[location, length, …]` pairs.
fn to_ranges(marks: &[bool]) -> Vec<i64> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < marks.len() {
        if marks[i] {
            let start = i;
            while i < marks.len() && marks[i] {
                i += 1;
            }
            out.push(start as i64);
            out.push((i - start) as i64);
        } else {
            i += 1;
        }
    }
    out
}

/// Carry `ranges` across one splice of the text they decorate.
///
/// `old_len` is the length of the text BEFORE the edit; `location`/`length` describe
/// the replaced span within it; `replacement_length` is how many units go in.
///
/// Inserted characters inherit the style only when the edit point is strictly inside a
/// run — the character before it is styled AND the character at it is too. Typing at
/// either EDGE of a bold word therefore leaves the new text unstyled, which is what
/// every editor does and what the shipped TypeScript already did.
pub fn splice_ranges(
    ranges: &[i64],
    old_len: i64,
    location: i64,
    length: i64,
    replacement_length: i64,
) -> Vec<i64> {
    if ranges.is_empty() {
        return Vec::new();
    }
    let old_len = old_len.max(0);
    let loc = location.clamp(0, old_len);
    let end = (loc + length.max(0)).clamp(loc, old_len);
    let ins = replacement_length.max(0);

    let marks = to_marks(ranges, old_len);
    let inherited = ins > 0
        && loc > 0
        && marks[(loc - 1) as usize]
        && if loc < old_len {
            marks[loc as usize]
        } else {
            false
        };

    let mut out: Vec<bool> = Vec::with_capacity((old_len - (end - loc) + ins) as usize);
    out.extend_from_slice(&marks[..loc as usize]);
    out.extend(std::iter::repeat(inherited).take(ins as usize));
    out.extend_from_slice(&marks[end as usize..]);
    to_ranges(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_before_a_run_shifts_it() {
        // "abcdef" with [2,2] ("cd"); insert "XY" at 0 → [4,2].
        assert_eq!(splice_ranges(&[2, 2], 6, 0, 0, 2), vec![4, 2]);
    }

    #[test]
    fn insert_inside_a_run_extends_it() {
        // "abcde" with [1,3] ("bcd"); replace "c" with "X" → still [1,3].
        assert_eq!(splice_ranges(&[1, 3], 5, 2, 1, 1), vec![1, 3]);
        // Pure insertion at 2, strictly inside → the run grows.
        assert_eq!(splice_ranges(&[1, 3], 5, 2, 0, 2), vec![1, 5]);
    }

    #[test]
    fn insert_at_a_run_edge_does_not_inherit() {
        // At the run's start: marks[loc-1] is unstyled.
        assert_eq!(splice_ranges(&[1, 3], 5, 1, 0, 2), vec![3, 3]);
        // At the run's end: marks[loc] is unstyled.
        assert_eq!(splice_ranges(&[1, 3], 5, 4, 0, 2), vec![1, 3]);
    }

    #[test]
    fn deleting_across_a_run_clips_it() {
        // "abcdef" with [2,2] ("cd"); delete [2,4) → the run is gone entirely.
        assert_eq!(splice_ranges(&[2, 2], 6, 2, 2, 0), Vec::<i64>::new());
        // Delete only "c" → [2,1].
        assert_eq!(splice_ranges(&[2, 2], 6, 2, 1, 0), vec![2, 1]);
    }

    #[test]
    fn multiple_runs_survive_independently() {
        // [0,1] and [3,1] over "abcde"; insert 2 units at 2 → [0,1] and [5,1].
        assert_eq!(splice_ranges(&[0, 1, 3, 1], 5, 2, 0, 2), vec![0, 1, 5, 1]);
    }

    #[test]
    fn a_delete_can_fuse_two_runs() {
        // [0,2] and [4,2] over "abcdef"; delete [2,4) → one run [0,4].
        assert_eq!(splice_ranges(&[0, 2, 4, 2], 6, 2, 2, 0), vec![0, 4]);
    }

    #[test]
    fn out_of_bounds_input_is_clamped_not_panicked() {
        assert_eq!(splice_ranges(&[10, 5], 3, 0, 0, 1), Vec::<i64>::new());
        assert_eq!(splice_ranges(&[0, 2], 3, 99, 99, 1), vec![0, 2]);
        assert_eq!(splice_ranges(&[0, 2], 3, -5, -5, 1), vec![1, 2]);
    }

    #[test]
    fn empty_ranges_stay_empty() {
        assert_eq!(splice_ranges(&[], 5, 1, 1, 3), Vec::<i64>::new());
    }
}
