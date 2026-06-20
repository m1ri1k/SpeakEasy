import hashlib
import hmac
import secrets


PASSWORD_HASH_ALGORITHM = "pbkdf2_sha256"
PASSWORD_HASH_ITERATIONS = 260_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        PASSWORD_HASH_ITERATIONS,
    )
    return f"{PASSWORD_HASH_ALGORITHM}${PASSWORD_HASH_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        parts = stored_hash.split("$")
    except ValueError:
        return False

    if len(parts) == 3:
        algorithm, salt, expected = parts
        iterations = 120_000
    elif len(parts) == 4:
        algorithm, iterations_raw, salt, expected = parts
        try:
            iterations = int(iterations_raw)
        except ValueError:
            return False
    else:
        return False

    if algorithm != PASSWORD_HASH_ALGORITHM:
        return False

    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations)
    return hmac.compare_digest(digest.hex(), expected)


def password_hash_needs_upgrade(stored_hash: str) -> bool:
    parts = stored_hash.split("$")
    if len(parts) != 4:
        return True
    algorithm, iterations_raw, _, _ = parts
    if algorithm != PASSWORD_HASH_ALGORITHM:
        return True
    try:
        return int(iterations_raw) < PASSWORD_HASH_ITERATIONS
    except ValueError:
        return True


def create_access_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
