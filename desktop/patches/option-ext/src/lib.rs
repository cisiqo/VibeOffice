//! `Option::contains` for crates that ask for it (dirs-sys: `user_dir.contains(&key)`): true when the option holds a
//! value equal to `x`. VibeOffice's own, Apache-2.0, in place of the MPL-2.0 option-ext crate.

pub trait OptionExt<T> {
    /// whether this is `Some(v)` with `x == v`
    fn contains<U>(&self, x: &U) -> bool
    where
        U: PartialEq<T>;
}

impl<T> OptionExt<T> for Option<T> {
    fn contains<U>(&self, x: &U) -> bool
    where
        U: PartialEq<T>,
    {
        match self {
            Some(v) => x.eq(v),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::OptionExt;

    #[test]
    fn contains() {
        assert!(Some("Desktop").contains(&"Desktop"));
        assert!(!Some("Desktop").contains(&"Music"));
        assert!(!None::<&str>.contains(&"Desktop"));
        assert!(Some(3).contains(&3));
    }
}
