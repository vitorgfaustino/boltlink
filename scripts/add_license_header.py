import os

# Textos do cabeçalho em inglês com o Disclaimer em inglês e português
HEADER_C_STYLE = """/*
 * Copyright (c) 2026 Vitor Faustino
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * ---
 * DISCLAIMER / ISENÇÃO DE RESPONSABILIDADE:
 * This software is provided "as is", without warranty of any kind.
 * Vitor Faustino (vitorfaustino.com.br) is not liable for any damages, 
 * losses, or inaccurate results arising from the use of this software.
 * 
 * Este software é fornecido "como está", sem garantias de qualquer tipo.
 * Vitor Faustino (vitorfaustino.com.br) não se responsabiliza por quaisquer
 * danos, perdas ou resultados imprecisos decorrentes do uso deste software.
 */

"""

HEADER_HASH_STYLE = """# Copyright (c) 2026 Vitor Faustino
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.
#
# ---
# DISCLAIMER / ISENÇÃO DE RESPONSABILIDADE:
# This software is provided "as is", without warranty of any kind.
# Vitor Faustino (vitorfaustino.com.br) is not liable for any damages, 
# losses, or inaccurate results arising from the use of this software.
# 
# Este software é fornecido "como está", sem garantias de qualquer tipo.
# Vitor Faustino (vitorfaustino.com.br) não se responsabiliza por quaisquer
# danos, perdas ou resultados imprecisos decorrentes do uso deste software.

"""

EXTENSIONS = {
    '.js': HEADER_C_STYLE,
    '.ts': HEADER_C_STYLE,
    '.css': HEADER_C_STYLE,
    '.py': HEADER_HASH_STYLE,
    '.sql': HEADER_C_STYLE,
}

IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', '.wrangler', '.gemini', 'docs', '.vscode', '.github']

def add_header_to_file(filepath):
    ext = os.path.splitext(filepath)[1]
    if ext not in EXTENSIONS:
        return

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"Skipping {filepath} due to read error: {e}")
        return

    # Evita duplicação do cabeçalho
    if "GNU Affero General Public License" in content[:2000]:
        return

    header = EXTENSIONS[ext]
    new_content = header + content

    try:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(new_content)
        print(f"Added header to {filepath}")
    except Exception as e:
        print(f"Failed to write to {filepath}: {e}")

def process_directory(directory):
    for root, dirs, files in os.walk(directory):
        # Filtra os diretórios ignorados
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]

        for file in files:
            ext = os.path.splitext(file)[1]
            if ext in EXTENSIONS:
                filepath = os.path.join(root, file)
                add_header_to_file(filepath)

if __name__ == "__main__":
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    print(f"Processing project at: {project_root}")
    process_directory(project_root)
