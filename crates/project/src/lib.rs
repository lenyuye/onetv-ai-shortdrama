//! OneTV 项目工程层：.ytv 工程文件夹 + SQLite + manifest（规格 §4）。

pub mod db;
pub mod error;
pub mod manifest;
pub mod ops;

pub use error::ProjectError;

use std::path::PathBuf;

/// 一个已打开的 .ytv 项目句柄。
#[derive(Debug, Clone)]
pub struct ProjectHandle {
    root: PathBuf,
}

impl ProjectHandle {
    pub fn root(&self) -> &PathBuf {
        &self.root
    }
    pub fn manifest_path(&self) -> PathBuf {
        self.root.join("project.json")
    }
    pub fn db_path(&self) -> PathBuf {
        self.root.join("database.sqlite")
    }
}
