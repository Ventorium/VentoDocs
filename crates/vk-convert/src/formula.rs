//! 极小公式求值器（对齐 POC `office_to_univer.py` 的子集）：
//! 单元格引用 / 跨表引用 / 四则运算 / 括号 / 一元负号 / 数字字面量。
//!
//! 真实 xlsx（Excel / WPS / LibreOffice 写出）的公式单元格自带缓存值，
//! 转换器直接取缓存值写入 `v`；本求值器只兜底"未计算即保存"的文件
//! （如 openpyxl 生成）。求值失败（超出子集语法、循环引用、除零）时
//! 单元格只保留 `f`，由 Univer 前端引擎加载后自行计算。

use std::collections::{HashMap, HashSet};

/// `(表名, A1 式单元格引用)`。
type CellKey = (String, String);

/// 公式求值环境：整个工作簿的数值单元格 + 全部公式。
#[derive(Default)]
pub struct FormulaBook {
    grid: HashMap<CellKey, f64>,
    formulas: HashMap<CellKey, String>,
}

impl FormulaBook {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_value(&mut self, sheet: &str, ref_name: &str, value: f64) {
        self.grid
            .insert((sheet.to_string(), ref_name.to_string()), value);
    }

    pub fn add_formula(&mut self, sheet: &str, ref_name: &str, formula: &str) {
        self.formulas.insert(
            (sheet.to_string(), ref_name.to_string()),
            formula.to_string(),
        );
    }

    /// 求值公式（无需前导 `=`），失败返回 `None`。
    pub fn eval(&self, formula: &str, sheet: &str) -> Option<f64> {
        let chars: Vec<char> = formula.chars().collect();
        let mut seen: HashSet<CellKey> = HashSet::new();
        let mut p = Pos {
            chars: &chars,
            i: 0,
        };
        let v = expr(self, &mut p, &mut seen, sheet)?;
        skip_ws(&mut p);
        (p.i == p.chars.len()).then_some(v)
    }
}

struct Pos<'a> {
    chars: &'a [char],
    i: usize,
}

fn peek(p: &Pos) -> Option<char> {
    p.chars.get(p.i).copied()
}

fn skip_ws(p: &mut Pos) {
    while p.i < p.chars.len() && p.chars[p.i].is_whitespace() {
        p.i += 1;
    }
}

fn expr(book: &FormulaBook, p: &mut Pos, seen: &mut HashSet<CellKey>, sheet: &str) -> Option<f64> {
    let mut v = term(book, p, seen, sheet)?;
    loop {
        skip_ws(p);
        match peek(p) {
            Some('+') => {
                p.i += 1;
                v += term(book, p, seen, sheet)?;
            }
            Some('-') => {
                p.i += 1;
                v -= term(book, p, seen, sheet)?;
            }
            _ => return Some(v),
        }
    }
}

fn term(book: &FormulaBook, p: &mut Pos, seen: &mut HashSet<CellKey>, sheet: &str) -> Option<f64> {
    let mut v = factor(book, p, seen, sheet)?;
    loop {
        skip_ws(p);
        match peek(p) {
            Some('*') => {
                p.i += 1;
                v *= factor(book, p, seen, sheet)?;
            }
            Some('/') => {
                p.i += 1;
                let right = factor(book, p, seen, sheet)?;
                if right == 0.0 {
                    return None;
                }
                v /= right;
            }
            _ => return Some(v),
        }
    }
}

fn factor(
    book: &FormulaBook,
    p: &mut Pos,
    seen: &mut HashSet<CellKey>,
    sheet: &str,
) -> Option<f64> {
    skip_ws(p);
    let ch = peek(p)?;
    if ch == '(' {
        p.i += 1;
        let v = expr(book, p, seen, sheet)?;
        skip_ws(p);
        if peek(p) != Some(')') {
            return None;
        }
        p.i += 1;
        return Some(v);
    }
    if ch == '-' {
        p.i += 1;
        return Some(-factor(book, p, seen, sheet)?);
    }
    if ch.is_ascii_digit() {
        let start = p.i;
        while let Some(c) = peek(p)
            && (c.is_ascii_digit() || c == '.')
        {
            p.i += 1;
        }
        let s: String = p.chars[start..p.i].iter().collect();
        return s.parse().ok();
    }
    if ch.is_alphanumeric() || ch == '$' || ch == '_' {
        let start = p.i;
        while let Some(c) = peek(p)
            && (c.is_alphanumeric() || c == '$' || c == '_')
        {
            p.i += 1;
        }
        let word: String = p.chars[start..p.i].iter().filter(|c| **c != '$').collect();
        if peek(p) == Some('!') {
            p.i += 1;
            let cell = parse_cell(p)?;
            return cell_value(book, seen, &word, &cell);
        }
        return cell_value(book, seen, sheet, &norm_ref(&word));
    }
    None
}

/// 解析单元格引用（允许 `$`），返回 A1 式（列大写）。
fn parse_cell(p: &mut Pos) -> Option<String> {
    if peek(p) == Some('$') {
        p.i += 1;
    }
    let cs = p.i;
    while let Some(c) = peek(p)
        && c.is_ascii_alphabetic()
    {
        p.i += 1;
    }
    if p.i == cs || p.i - cs > 3 {
        return None;
    }
    let col: String = p.chars[cs..p.i]
        .iter()
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if peek(p) == Some('$') {
        p.i += 1;
    }
    let rs = p.i;
    while let Some(c) = peek(p)
        && c.is_ascii_digit()
    {
        p.i += 1;
    }
    if p.i == rs {
        return None;
    }
    let row: String = p.chars[rs..p.i].iter().collect();
    Some(format!("{col}{row}"))
}

/// 归一化同表引用：去 `$`、列转大写（`$a$1` → `A1`）。
fn norm_ref(word: &str) -> String {
    let mut out = String::new();
    for c in word.chars() {
        if c == '$' {
            continue;
        }
        out.push(c.to_ascii_uppercase());
    }
    out
}

fn cell_value(
    book: &FormulaBook,
    seen: &mut HashSet<CellKey>,
    sheet: &str,
    ref_name: &str,
) -> Option<f64> {
    let key = (sheet.to_string(), ref_name.to_string());
    if let Some(v) = book.grid.get(&key) {
        return Some(*v);
    }
    if let Some(f) = book.formulas.get(&key) {
        if !seen.insert(key.clone()) {
            return None; // 循环引用
        }
        let chars: Vec<char> = f.chars().collect();
        let mut p = Pos {
            chars: &chars,
            i: 0,
        };
        let v = expr(book, &mut p, seen, &key.0)?;
        skip_ws(&mut p);
        let res = (p.i == p.chars.len()).then_some(v);
        seen.remove(&key);
        return res;
    }
    Some(0.0)
}

/// 0-based 列号 → Excel 列名（0 → A，25 → Z，26 → AA）。
pub fn col_to_letters(col: u32) -> String {
    let mut n = col as u64 + 1;
    let mut s = String::new();
    while n > 0 {
        n -= 1;
        s.insert(0, (b'A' + (n % 26) as u8) as char);
        n /= 26;
    }
    s
}

/// A1 式引用（0-based row/col）。
pub fn cell_ref(row: u32, col: u32) -> String {
    format!("{}{}", col_to_letters(col), row + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book() -> FormulaBook {
        let mut b = FormulaBook::new();
        b.add_value("销售", "A1", 30.0);
        b.add_value("销售", "B1", 12.0);
        b.add_formula("销售", "A2", "A1+B1");
        b.add_value("销售", "E6", 44.0);
        b.add_value("销售", "F6", 9.5);
        b.add_formula("销售", "G6", "E6*F6");
        b.add_formula("备注", "A2", "销售!A2+销售!G6*0");
        b
    }

    #[test]
    fn arithmetic_and_refs() {
        let b = book();
        assert_eq!(b.eval("A1+B1", "销售"), Some(42.0));
        assert_eq!(b.eval("A1 * 2 - 4 / 2", "销售"), Some(58.0));
        assert_eq!(b.eval("(A1+B1)/2", "销售"), Some(21.0));
        assert_eq!(b.eval("-A1+30", "销售"), Some(0.0));
        assert_eq!(b.eval("E6*F6", "销售"), Some(418.0));
    }

    #[test]
    fn cross_sheet_and_nested() {
        let b = book();
        assert_eq!(b.eval("销售!A2", "备注"), Some(42.0));
        assert_eq!(b.eval("销售!A2*2", "备注"), Some(84.0));
        assert_eq!(b.eval("销售!G6", "销售"), Some(418.0));
    }

    #[test]
    fn failure_cases() {
        let b = book();
        assert_eq!(b.eval("1/0", "销售"), None);
        assert_eq!(b.eval("SUM(A1:A2)", "销售"), None); // 函数超出子集
        assert_eq!(b.eval("A1+", "销售"), None); // 悬挂运算符
    }

    #[test]
    fn cyclic_and_unknown() {
        let mut b = book();
        b.add_formula("销售", "Z9", "Z9+1");
        assert_eq!(b.eval("Z9", "销售"), None); // 循环引用
        assert_eq!(b.eval("A1+AA99", "销售"), Some(30.0 + 0.0)); // 未知单元格按 0
        assert_eq!(b.eval("$a$1+$B$1", "销售"), Some(42.0));
    }
}
