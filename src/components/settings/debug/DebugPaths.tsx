import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type DebugPaths as ResolvedDebugPaths } from "@/bindings";
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
  const [paths, setPaths] = useState<ResolvedDebugPaths>();

  useEffect(() => {
    commands.getDebugPaths().then((result) => {
      if (result.status === "ok") setPaths(result.data);
    });
  }, []);

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
          <span className="font-mono text-xs select-text">
            {paths?.app_data}
          </span>
        </div>
        <div>
          <span className="font-medium">
            {t("settings.debug.paths.models")}
          </span>{" "}
          <span className="font-mono text-xs select-text">{paths?.models}</span>
        </div>
        <div>
          <span className="font-medium">
            {t("settings.debug.paths.settings")}
          </span>{" "}
          <span className="font-mono text-xs select-text">
            {paths?.settings}
          </span>
        </div>
        <div>
          <span className="font-medium">{t("settings.debug.paths.logs")}</span>{" "}
          <span className="font-mono text-xs select-text">{paths?.logs}</span>
        </div>
      </div>
    </SettingContainer>
  );
};
