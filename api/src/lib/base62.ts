const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function toBase62(value: number): string {
    let result = ''

    while(value > 0) {
        const remainder = value % 62
        result = ALPHABET[remainder] + result
        value = Math.floor(value / 62)
    }

    return result
}

export function fromBase62(code: string): number {
    let result = 0

    for (const char of code) {
        const position = ALPHABET.indexOf(char)
        result = result * 62 + position
    }

    return result 
}