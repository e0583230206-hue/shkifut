export interface Report {
    id: number;
    messageId: number;
    reason: string;
    createdAt: Date;
    updatedAt: Date;
    reporterId: string;
    reporterName: string;
    reportedEmail: string;
    closed: boolean;
    closedBy?: string;   // admin only; shown while closed
    closedAt?: string;
    reply?: string;      // shown to the reporter in his personal area
    repliedAt?: string;
    replyBy?: string;    // admin only
}

export type Reports = Report[];