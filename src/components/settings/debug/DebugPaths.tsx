import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { SettingContainer } from "../../ui/SettingContainer";

interface DebugPathsProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
}

export const DebugPaths: React.FC<DebugPathsProps> = ({
  descriptionMode = "inline",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const [appDataDir, setAppDataDir] = useState("");
  const [logDir, setLogDir] = useState("");

  useEffect(() => {
    Promise.all([commands.getAppDirPath(), commands.getLogDirPath()]).then(
      ([appDataResult, logResult]) => {
        if (appDataResult.status === "ok") setAppDataDir(appDataResult.data);
        if (logResult.status === "ok") setLogDir(logResult.data);
      },
    );
  }, []);

  const joinPath = (base: string, child: string) => {
    if (!base) return "";
    const separator = base.includes("\\") ? "\\" : "/";
    return `${base.replace(/[\\/]$/u, "")}${separator}${child}`;
  };

  return (
    <SettingContainer
      title={t("settings.debug.paths.title")}
      description={t("settings.debug.paths.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
    >
      <div className="text-sm text-gray-600 space-y-2">
        <div>
          <span className="font-medium">
            {t("settings.debug.paths.appData")}
          </span>{" "}
          <span className="font-mono text-xs select-text">{appDataDir}</span>
        </div>
        <div>
          <span className="font-medium">
            {t("settings.debug.paths.models")}
          </span>{" "}
          <span className="font-mono text-xs select-text">
            {joinPath(appDataDir, "models")}
          </span>
        </div>
        <div>
          <span className="font-medium">
            {t("settings.debug.paths.settings")}
          </span>{" "}
          <span className="font-mono text-xs select-text">
            {joinPath(appDataDir, "settings_store.json")}
          </span>
        </div>
        <div>
          <span className="font-medium">{t("settings.debug.paths.logs")}</span>{" "}
          <span className="font-mono text-xs select-text">{logDir}</span>
        </div>
      </div>
    </SettingContainer>
  );
};
