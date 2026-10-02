/**
 * OneTV Skill SDK —— Skill 包格式与安全等级（规格 §10）。
 * Skill 只能声明能力与工作流；不允许任意访问文件系统和网络。
 */
import type { SkillManifest } from "@onetv/shared-types";

export const SKILL_TRUST_LABELS: Record<number, string> = {
  0: "L0 仅提示/Schema（直接允许）",
  1: "L1 项目读写（首次安装确认）",
  2: "L2 Provider 网络（逐 Provider 授权）",
  3: "L3 Shell/任意文件（默认禁止）",
};

export function validateSkillManifest(m: Partial<SkillManifest>): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!m.id || !/^[a-z0-9][a-z0-9-_]*$/.test(m.id)) errors.push("id 必须是小写字母/数字/连字符");
  if (!m.name) errors.push("缺少 name");
  if (!m.version || !/^\d+\.\d+\.\d+$/.test(m.version)) errors.push("version 必须是 semver");
  if (!m.entry || !m.entry.startsWith("workflows/")) errors.push("entry 必须位于 workflows/ 内");
  if (!m.permissions) errors.push("必须声明 permissions");
  else {
    if (m.permissions.filesystem.some((p) => p !== "project")) {
      errors.push("filesystem 权限只允许 project（L3 需要单独审批的 Skill 不允许通过普通安装导入）");
    }
    if (m.permissions.network.some((n) => n !== "provider" && n !== "none")) {
      errors.push("network 权限只允许 provider / none");
    }
  }
  return { ok: errors.length === 0, errors };
}

export const SKILL_LEVEL_FOR_PERMISSIONS = (m: SkillManifest): 0 | 1 | 2 => {
  if (m.permissions.network.includes("provider")) return 2;
  if (m.permissions.filesystem.includes("project")) return 1;
  return 0;
};
