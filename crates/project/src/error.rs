use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON 错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("SQLite 错误: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("路径错误: {0}")]
    Path(String),
    #[error("工程文件不合法: {0}")]
    Invalid(String),
    #[error("schema 版本不支持: {0}")]
    SchemaVersion(String),
}

pub type ProjectResult<T> = Result<T, ProjectError>;
