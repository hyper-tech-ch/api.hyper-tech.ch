export type AuthorizationToken = {
	FriendlyName: string,
	SecretKey: string,
	AllowedServices: string[],

	IssuedAt: Date,
	ExpiresAt?: Date,
}