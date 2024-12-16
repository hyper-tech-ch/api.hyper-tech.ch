import { AuthorizationToken } from "exports/token";

export default {
	FriendlyName: "Test",
	SecretKey: "ht-key.XXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
	AllowedServices: [],

	IssuedAt:  new Date(2024, 12, 12),
	ExpiresAt: new Date(2030, 1, 1),
} satisfies AuthorizationToken