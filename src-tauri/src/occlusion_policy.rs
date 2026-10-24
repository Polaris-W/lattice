//! 遮挡判定的纯逻辑：取哪几个点、命中几个才算"被挡住"
//!
//! 为什么单独一个文件：`occlusion.rs` 要碰 Win32（`WindowFromPoint` 之类），
//! 这台机器上 `cargo test` 跑不了（安全策略拦 `target/debug/deps` 下新写的
//! exe，见 ROADMAP 坑表）。把"取哪几个采样点、几个没命中才算看不见"抽成
//! 纯函数，就能用 `rustc --test` 壳子单独编一遍 —— 断言还是这一份，不复制。
//!
//! # 为什么是"一个都没命中"才算挡住
//!
//! 被挡一半的组件要不要停？停的话用户会看见一张卡住的卡（一半露在外面却
//! 不刷新），那比多跑几拍电更糟。所以判据取最保守的一端：九个采样点**全部**
//! 落在别人窗口上才认为"看不见"。代价是斜着露出一角的组件仍然在跑 ——
//! 这个方向的误判只是多耗一点电，反方向的误判是"看着像坏了"。

/// 采样点（窗口客户区坐标）
///
/// 3×3 网格、向内缩进，这样边角上的圆角、窗饰、阴影都不会把采样点吃掉。
/// 太小的窗口（小于 3px）退回中心一个点 —— 再分下去三个点会重合到同一像素。
pub fn sample_points(width: i32, height: i32) -> Vec<(i32, i32)> {
    if width <= 0 || height <= 0 {
        return Vec::new();
    }
    if width < 3 || height < 3 {
        return vec![(width / 2, height / 2)];
    }

    // 缩进按短边算，夹在 1..=8：240×140 的卡片缩 8px 刚好避开圆角，
    // 8px 的小窗缩 1px 也不至于缩成负的
    let inset = (width.min(height) / 8).clamp(1, 8);
    let xs = [inset, width / 2, width - 1 - inset];
    let ys = [inset, height / 2, height - 1 - inset];

    let mut points = Vec::with_capacity(9);
    for y in ys {
        for x in xs {
            points.push((x, y));
        }
    }
    points
}

/// 九个点一个都没打在自己身上，才算被挡住
///
/// `total == 0`（窗口量不出尺寸）时返回 false：不知道就别停，
/// 和 `visibility.rs` 里"读不到就当可见"是同一条规矩。
pub fn covered(hits: usize, total: usize) -> bool {
    total > 0 && hits == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_is_nine_points() {
        assert_eq!(sample_points(240, 140).len(), 9);
        assert_eq!(sample_points(300, 340).len(), 9);
    }

    #[test]
    fn points_stay_inside_the_client_area() {
        for (w, h) in [(240, 140), (300, 340), (200, 150), (8, 8), (4, 40), (40, 4)] {
            for (x, y) in sample_points(w, h) {
                assert!(x >= 0 && x < w, "{w}x{h}: x={x} 越界");
                assert!(y >= 0 && y < h, "{w}x{h}: y={y} 越界");
            }
        }
    }

    #[test]
    fn inset_avoids_the_corners() {
        // 240×140 短边 140，140/8 = 17 → 夹到 8
        let points = sample_points(240, 140);
        assert!(points.contains(&(8, 8)), "左上角要缩进 8px：{points:?}");
        assert!(points.contains(&(231, 131)), "右下角要缩进 8px：{points:?}");
        assert!(!points.contains(&(0, 0)), "角上那一点不能取到 0,0");
    }

    #[test]
    fn centre_point_is_the_middle() {
        let points = sample_points(240, 140);
        assert!(points.contains(&(120, 70)), "中间那一点要在正中心：{points:?}");
    }

    #[test]
    fn tiny_windows_fall_back_to_the_centre() {
        assert_eq!(sample_points(2, 2), vec![(1, 1)]);
        assert_eq!(sample_points(1, 40), vec![(0, 20)]);
        assert_eq!(sample_points(3, 3).len(), 9, "3px 刚好还能分网格");
    }

    #[test]
    fn unmeasurable_windows_have_no_points() {
        assert_eq!(sample_points(0, 140), Vec::new());
        assert_eq!(sample_points(240, 0), Vec::new());
        assert_eq!(sample_points(-5, 140), Vec::new());
    }

    #[test]
    fn covered_needs_zero_hits() {
        assert!(covered(0, 9), "一个都没命中 = 被挡住");
        assert!(!covered(1, 9), "哪怕命中一个也不算挡住");
        assert!(!covered(9, 9), "全命中当然不算");
    }

    #[test]
    fn unknown_is_not_covered() {
        // 量不出尺寸时不能顺手把组件停掉 —— 那会让卡片冻在最后一帧
        assert!(!covered(0, 0));
    }
}
