import { PunchCardValidator } from "./punch-card-validator.js";
import type { SubtaskValidation } from "./types.js";

export class SubtaskVerifier {
  constructor(private readonly validator: PunchCardValidator) {}

  async connect(): Promise<void> {
    await this.validator.connect();
  }

  async disconnect(): Promise<void> {
    await this.validator.disconnect();
  }

  async verifySubtasks(parentTaskId: string, childCardId: string): Promise<SubtaskValidation> {
    const childIds = await this.validator.getChildIds(parentTaskId);
    const children: SubtaskValidation["children"] = [];

    for (const childId of childIds) {
      const validation = await this.validator.validatePunchCard(childId, childCardId);
      children.push({ childId, validation });
    }

    return {
      parentTaskId,
      children,
      allChildrenValid: children.every((child) => child.validation.status === "pass"),
    };
  }
}
